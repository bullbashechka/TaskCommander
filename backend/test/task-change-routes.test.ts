import { describe, expect, it, vi } from 'vitest';

import {
  bulkOperationDraftAvailabilitySchema,
  bulkOperationDraftSchema,
  bulkOperationSchema,
  taskChangeCatalogResponseSchema,
  preflightPreviewSchema,
  taskPreflightConfirmationSchema,
  type BulkOperationDraft,
} from '@task-commander/contracts';

import { createApi } from '../src/api';
import { resolveEffectiveAccess } from '../src/data/access';
import { DataAccessError } from '../src/data/errors';
import type { Json } from '../src/data/database.types';
import { createMockBitrixAdapter } from '../src/integrations/bitrix/mock';
import type { TaskChangeRepository } from '../src/task-changes/routes';
import { createVerifiedTestPrincipal } from './verified-session-test-helper';

const environment = {
  APP_ENV: 'local',
  APP_ORIGIN: 'https://example.test',
  BITRIX_PORTAL_ORIGIN: 'https://portal.bitrix24.ru',
  OPERATION_PLAN_KEY_V1: btoa('k'.repeat(32)),
  ACCESS_FANOUT_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
};

const headers = {
  origin: 'https://example.test',
  'sec-fetch-site': 'same-origin',
  cookie: 'tc_session=test',
  'content-type': 'application/json',
};

async function setup(input?: {
  permissions?: (
    | 'app_access'
    | 'run_bulk_operations'
    | 'change_allowed_fields'
    | 'view_own_reports'
    | 'retry_operations'
  )[];
  allowedFieldIds?: string[];
  saveError?: DataAccessError;
  includeForbiddenCapabilities?: boolean;
  currentDraft?: BulkOperationDraft;
  currentPreflightSnapshot?: Json | null;
  renewedAccessVersion?: number;
}) {
  const principal = await createVerifiedTestPrincipal({ userId: '10' });
  const permissions = input?.permissions ?? [
    'app_access',
    'run_bulk_operations',
    'change_allowed_fields',
  ];
  const access = await resolveEffectiveAccess(principal, {
    findEffectiveAccessSettings: async () => ({
      accessActive: true,
      permissions,
      allowedFieldIds: input?.allowedFieldIds ?? ['title', 'status', 'tags'],
      accessVersion: 1,
    }),
  });
  const renewedAccess =
    input?.renewedAccessVersion === undefined
      ? access
      : await resolveEffectiveAccess(principal, {
          findEffectiveAccessSettings: async () => ({
            accessActive: true,
            permissions,
            allowedFieldIds: input.allowedFieldIds ?? ['title', 'status', 'tags'],
            accessVersion: input.renewedAccessVersion,
          }),
        });
  let accessReadCount = 0;
  const getCurrentDraft = vi
    .fn<TaskChangeRepository['getCurrentDraft']>()
    .mockResolvedValue(input?.currentDraft ?? null);
  const getCurrentDraftForPreflight = vi
    .fn<TaskChangeRepository['getCurrentDraftForPreflight']>()
    .mockResolvedValue(
      input?.currentDraft
        ? {
            draft: input.currentDraft,
            preflightSnapshot: input.currentPreflightSnapshot ?? null,
          }
        : null,
    );
  const saveDraft = vi
    .fn<TaskChangeRepository['saveDraft']>()
    .mockImplementation(async (_context, draft) => {
      if (input?.saveError) throw input.saveError;
      return bulkOperationDraftSchema.parse({
        id: '123e4567-e89b-42d3-a456-426614174000',
        ownerId: principal.userId,
        revision: draft.expectedRevision + 1,
        status: draft.status,
        filters: (draft.filterSnapshot as { filters: unknown[] }).filters,
        sort: draft.sortSnapshot,
        selectedTaskIds: draft.selectedTaskIds,
        changes: draft.changes,
        createdAt: '2026-09-04T10:00:00Z',
        updatedAt: '2026-09-04T10:00:00Z',
        expiresAt: '2026-09-05T10:00:00Z',
      });
    });
  const saveTaskPreflight = vi
    .fn<TaskChangeRepository['saveTaskPreflight']>()
    .mockImplementation(async (_context, preflight) => {
      if (!input?.currentDraft) throw new DataAccessError('CONFLICT', false);
      return {
        draft: { ...input.currentDraft, revision: preflight.expectedRevision + 1 },
        preflightSnapshot: preflight.preflightSnapshot,
      };
    });
  const confirmTaskPreflight = vi
    .fn<TaskChangeRepository['confirmTaskPreflight']>()
    .mockImplementation(async (_context, confirmation) => ({
      draftId: confirmation.draftId,
      draftRevision: confirmation.draftRevision,
      token: '223e4567-e89b-42d3-a456-426614174000',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
  const repository: TaskChangeRepository = {
    ensurePrincipalIdentity: vi.fn(),
    getCurrentDraft,
    getCurrentDraftForPreflight,
    saveDraft,
    saveTaskPreflight,
    confirmTaskPreflight,
    findOperationByLaunchKey: vi.fn().mockResolvedValue(null),
    readConfirmedOperationReceipt: vi.fn(),
    getOwnedOperationProgress: vi.fn(),
    getLatestOwnedOperationProgress: vi.fn().mockResolvedValue(null),
    listOwnedOperationProgressResults: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    requestOperationCancellation: vi.fn(),
    launchConfirmedTaskPreflight: vi.fn(),
    claimOperationLaunchDispatch: vi.fn().mockResolvedValue(null),
    completeOperationLaunchDispatch: vi.fn(),
    retryConfirmedOperationLaunch: vi.fn(),
  };
  const adapterFactory = vi.fn((_env: unknown, adapterInput: { currentUserId: string }) => {
    const adapter = createMockBitrixAdapter({ currentUserId: adapterInput.currentUserId });
    if (!input?.includeForbiddenCapabilities) return adapter;
    return {
      ...adapter,
      tasks: {
        ...adapter.tasks,
        getFieldCapabilities: async () => {
          const result = await adapter.tasks.getFieldCapabilities();
          if (!result.ok) return result;
          return {
            ok: true as const,
            value: [
              ...result.value.map((field) => {
                if (field.id === 'status') {
                  return {
                    ...field,
                    filterOptions: [
                      ...field.filterOptions,
                      { value: 'completed', label: 'Завершена' },
                    ],
                  };
                }
                return field.id === 'UF_TASK_APPROVED' ? { ...field, isNullable: true } : field;
              }),
              {
                id: 'attachments',
                sourceType: 'file',
                kind: 'text' as const,
                isMultiple: true,
                isNullable: true,
                isEditable: true,
                isSupported: true,
                filterLabel: 'Вложения',
                isFilterable: true,
                isSortable: false,
                filterValueSource: 'text' as const,
                filterOptions: [],
              },
            ],
          };
        },
      },
    };
  });
  const api = createApi({
    readPrincipal: async () => principal,
    readEffectiveAccess: async () => {
      accessReadCount += 1;
      return accessReadCount >= 2 ? renewedAccess : access;
    },
    createBitrixAdapter: adapterFactory,
    createTaskChangeRepository: () => repository,
  });
  return {
    api,
    repository,
    adapterFactory,
    getCurrentDraft,
    getCurrentDraftForPreflight,
    saveDraft,
    saveTaskPreflight,
    confirmTaskPreflight,
  };
}

const currentDraft: BulkOperationDraft = {
  id: '123e4567-e89b-42d3-a456-426614174000',
  ownerId: '10',
  revision: 3,
  status: 'preparing',
  filters: [],
  sort: { fieldId: 'deadline', direction: 'asc' },
  selectedTaskIds: ['42', '45', '48', '49'],
  changes: [{ fieldId: 'title', kind: 'text', action: 'set', value: 'Updated title' }],
  createdAt: '2026-09-04T10:00:00Z',
  updatedAt: '2026-09-04T10:00:00Z',
  expiresAt: '2026-09-05T10:00:00Z',
};

describe('task change routes', () => {
  it('returns only supported, editable and allowlisted fields without completed status', async () => {
    const { api } = await setup({
      allowedFieldIds: ['title', 'status', 'tags', 'attachments'],
      includeForbiddenCapabilities: true,
    });
    const response = await api.request(
      'https://example.test/api/tasks/change-fields',
      { headers },
      environment,
    );
    const body = taskChangeCatalogResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(body.fields.map((field) => field.id)).toEqual(['title', 'status', 'tags']);
    expect(
      body.fields.find((field) => field.id === 'status')?.options.map((option) => option.value),
    ).not.toContain('completed');
    expect(body.fields.find((field) => field.id === 'title')?.actions).toEqual(['set']);
    expect(body.fields.find((field) => field.id === 'tags')?.actions).toEqual([
      'replace',
      'add',
      'remove',
      'clear',
    ]);
  });

  it.each([
    {
      fieldId: 'status',
      kind: 'list',
      action: 'set',
      value: 'completed',
    },
    {
      fieldId: 'attachments',
      kind: 'text',
      action: 'set',
      value: 'file-token',
    },
  ])('rejects forbidden change $fieldId even when the adapter exposes it', async (change) => {
    const { api, saveDraft } = await setup({
      allowedFieldIds: ['status', 'attachments'],
      includeForbiddenCapabilities: true,
    });
    const response = await api.request(
      'https://example.test/api/tasks/draft',
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          expectedRevision: 0,
          replaceExpired: true,
          selectedTaskIds: ['42'],
          filters: [],
          sort: { fieldId: 'deadline', direction: 'asc' },
          changes: [change],
        }),
      },
      environment,
    );

    expect(response.status).toBe(400);
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it('authorizes before reading capabilities or drafts', async () => {
    const { api, adapterFactory, getCurrentDraft } = await setup({
      permissions: ['app_access', 'run_bulk_operations'],
    });
    const response = await api.request(
      'https://example.test/api/tasks/change-fields',
      { headers },
      environment,
    );

    expect(response.status).toBe(403);
    expect(adapterFactory).not.toHaveBeenCalled();
    expect(getCurrentDraft).not.toHaveBeenCalled();
  });

  it('round-trips clear for a nullable boolean field', async () => {
    const { api, saveDraft } = await setup({
      allowedFieldIds: ['UF_TASK_APPROVED'],
      includeForbiddenCapabilities: true,
    });
    const catalogResponse = await api.request(
      'https://example.test/api/tasks/change-fields',
      { headers },
      environment,
    );
    expect(
      taskChangeCatalogResponseSchema
        .parse(await catalogResponse.json())
        .fields.find((field) => field.id === 'UF_TASK_APPROVED')?.actions,
    ).toEqual(['set', 'clear']);

    const response = await api.request(
      'https://example.test/api/tasks/draft',
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          expectedRevision: 0,
          replaceExpired: true,
          selectedTaskIds: ['42'],
          filters: [],
          sort: { fieldId: 'deadline', direction: 'asc' },
          changes: [{ fieldId: 'UF_TASK_APPROVED', kind: 'boolean', action: 'clear' }],
        }),
      },
      environment,
    );

    expect(response.status).toBe(200);
    expect(saveDraft).toHaveBeenCalledTimes(1);
  });

  it('returns an explicit empty draft state without restoring anything', async () => {
    const { api } = await setup();
    const response = await api.request(
      'https://example.test/api/tasks/draft',
      { headers },
      environment,
    );

    expect(response.status).toBe(200);
    expect(bulkOperationDraftAvailabilitySchema.parse(await response.json())).toEqual({
      draft: null,
    });
  });

  it('revalidates commands and saves a preparing draft with cleared preflight', async () => {
    const { api, saveDraft } = await setup();
    const response = await api.request(
      'https://example.test/api/tasks/draft',
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          expectedRevision: 0,
          replaceExpired: true,
          selectedTaskIds: ['42'],
          filters: [],
          sort: { fieldId: 'deadline', direction: 'asc' },
          changes: [{ fieldId: 'title', kind: 'text', action: 'set', value: 'Новый заголовок' }],
        }),
      },
      environment,
    );

    expect(response.status).toBe(200);
    expect(bulkOperationDraftSchema.parse(await response.json()).revision).toBe(1);
    expect(saveDraft).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: 'preparing',
        filterSnapshot: { filters: [] },
        sortSnapshot: { fieldId: 'deadline', direction: 'asc' },
        preflightSnapshot: null,
      }),
    );
  });

  it('rejects a field outside the current allowlist before persistence', async () => {
    const { api, saveDraft } = await setup();
    const response = await api.request(
      'https://example.test/api/tasks/draft',
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          expectedRevision: 0,
          replaceExpired: true,
          selectedTaskIds: ['42'],
          filters: [],
          sort: { fieldId: 'deadline', direction: 'asc' },
          changes: [{ fieldId: 'deadline', kind: 'date_time', action: 'clear' }],
        }),
      },
      environment,
    );

    expect(response.status).toBe(400);
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it('maps a stale draft revision to conflict', async () => {
    const { api } = await setup({ saveError: new DataAccessError('CONFLICT', false) });
    const response = await api.request(
      'https://example.test/api/tasks/draft',
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          expectedRevision: 4,
          selectedTaskIds: ['42'],
          filters: [],
          sort: { fieldId: 'deadline', direction: 'asc' },
          changes: [{ fieldId: 'title', kind: 'text', action: 'set', value: 'Новый заголовок' }],
        }),
      },
      environment,
    );

    expect(response.status).toBe(409);
  });

  it('preflights every selected task and persists the owner-bound revision snapshot', async () => {
    const { api, saveTaskPreflight } = await setup({ currentDraft });
    const response = await api.request(
      'https://example.test/api/tasks/preflight',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ draftId: currentDraft.id, expectedRevision: 3 }),
      },
      environment,
    );
    const preview = preflightPreviewSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(preview.entries.map((entry) => [entry.taskId, entry.disposition])).toEqual([
      ['42', 'eligible'],
      ['45', 'excluded_by_preflight'],
      ['48', 'excluded_by_preflight'],
      ['49', 'excluded_by_preflight'],
    ]);
    expect(preview.entries[1]).toMatchObject({
      title: null,
      taskUrl: null,
      reasonCode: 'TASK_COMPLETED',
    });
    expect(preview.entries[2]).toMatchObject({
      title: null,
      taskUrl: null,
      reasonCode: 'TASK_UNAVAILABLE',
    });
    expect(preview.summary).toMatchObject({ selected: 4, eligible: 1, excluded: 3 });
    expect(preview.canProceed).toBe(true);
    expect(saveTaskPreflight).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        draftId: currentDraft.id,
        expectedRevision: 3,
      }),
    );
  });

  it('returns an already persisted preflight for an exact HTTP retry', async () => {
    const first = await setup({ currentDraft });
    const firstResponse = await first.api.request(
      'https://example.test/api/tasks/preflight',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ draftId: currentDraft.id, expectedRevision: 3 }),
      },
      environment,
    );
    const preview = preflightPreviewSchema.parse(await firstResponse.json());
    const replayDraft = { ...currentDraft, revision: 4, status: 'awaiting_confirmation' as const };
    const replay = await setup({
      currentDraft: replayDraft,
      currentPreflightSnapshot: preview as unknown as Json,
    });
    const response = await replay.api.request(
      'https://example.test/api/tasks/preflight',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ draftId: currentDraft.id, expectedRevision: 3 }),
      },
      environment,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(preview);
    expect(replay.adapterFactory).not.toHaveBeenCalled();
    expect(replay.saveTaskPreflight).not.toHaveBeenCalled();
  });

  it('rejects a foreign or stale draft binding before Bitrix reads', async () => {
    const { api, adapterFactory, saveTaskPreflight } = await setup({ currentDraft });
    const response = await api.request(
      'https://example.test/api/tasks/preflight',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          draftId: '223e4567-e89b-42d3-a456-426614174000',
          expectedRevision: 3,
        }),
      },
      environment,
    );

    expect(response.status).toBe(409);
    expect(adapterFactory).not.toHaveBeenCalled();
    expect(saveTaskPreflight).not.toHaveBeenCalled();
  });

  it('rejects access changed during external validation before persistence', async () => {
    const { api, saveTaskPreflight } = await setup({ currentDraft, renewedAccessVersion: 2 });
    const response = await api.request(
      'https://example.test/api/tasks/preflight',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ draftId: currentDraft.id, expectedRevision: 3 }),
      },
      environment,
    );

    expect(response.status).toBe(409);
    expect(saveTaskPreflight).not.toHaveBeenCalled();
  });

  it('rejects a stored replay that no longer matches the draft selection', async () => {
    const first = await setup({ currentDraft });
    const firstResponse = await first.api.request(
      'https://example.test/api/tasks/preflight',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ draftId: currentDraft.id, expectedRevision: 3 }),
      },
      environment,
    );
    const preview = preflightPreviewSchema.parse(await firstResponse.json());
    const corrupted = {
      ...preview,
      entries: preview.entries.map((entry, index) =>
        index === 0 ? { ...entry, taskId: '999' } : entry,
      ),
    };
    const replay = await setup({
      currentDraft: { ...currentDraft, revision: 4, status: 'awaiting_confirmation' },
      currentPreflightSnapshot: corrupted as unknown as Json,
    });
    const response = await replay.api.request(
      'https://example.test/api/tasks/preflight',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ draftId: currentDraft.id, expectedRevision: 3 }),
      },
      environment,
    );

    expect(response.status).toBe(409);
    expect(replay.saveTaskPreflight).not.toHaveBeenCalled();
  });

  it('confirms only the stored owner snapshot and passes its fingerprint to persistence', async () => {
    const first = await setup({ currentDraft });
    const firstResponse = await first.api.request(
      'https://example.test/api/tasks/preflight',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ draftId: currentDraft.id, expectedRevision: 3 }),
      },
      environment,
    );
    const preview = preflightPreviewSchema.parse(await firstResponse.json());
    const saved = await setup({
      currentDraft: { ...currentDraft, revision: 4, status: 'awaiting_confirmation' },
      currentPreflightSnapshot: preview as unknown as Json,
    });
    const response = await saved.api.request(
      'https://example.test/api/tasks/preflight/confirm',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          draftId: currentDraft.id,
          draftRevision: 4,
          checkedAt: preview.checkedAt,
        }),
      },
      environment,
    );

    expect(response.status).toBe(200);
    expect(taskPreflightConfirmationSchema.parse(await response.json()).draftRevision).toBe(4);
    expect(saved.confirmTaskPreflight).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        preflightSnapshot: preview,
        snapshotFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );

    const stale = await saved.api.request(
      'https://example.test/api/tasks/preflight/confirm',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          draftId: currentDraft.id,
          draftRevision: 4,
          checkedAt: '2026-09-01T00:00:00Z',
        }),
      },
      environment,
    );
    expect(stale.status).toBe(409);
    expect(saved.confirmTaskPreflight).toHaveBeenCalledTimes(1);
  });

  it('rate limits confirmation before reading a draft or issuing a token', async () => {
    const { api, getCurrentDraftForPreflight, confirmTaskPreflight } = await setup({
      currentDraft,
    });
    vi.mocked(environment.ACCESS_FANOUT_RATE_LIMITER.limit).mockResolvedValueOnce({
      success: false,
    });
    const response = await api.request(
      'https://example.test/api/tasks/preflight/confirm',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          draftId: currentDraft.id,
          draftRevision: 4,
          checkedAt: new Date().toISOString(),
        }),
      },
      environment,
    );

    expect(response.status).toBe(429);
    expect(getCurrentDraftForPreflight).not.toHaveBeenCalled();
    expect(confirmTaskPreflight).not.toHaveBeenCalled();
  });

  it('launches the saved snapshot once and replays an owner-scoped operation without a draft', async () => {
    const first = await setup({ currentDraft });
    const firstResponse = await first.api.request(
      'https://example.test/api/tasks/preflight',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ draftId: currentDraft.id, expectedRevision: 3 }),
      },
      environment,
    );
    const preview = preflightPreviewSchema.parse(await firstResponse.json());
    const saved = await setup({
      currentDraft: { ...currentDraft, revision: 4, status: 'awaiting_confirmation' },
      currentPreflightSnapshot: preview as unknown as Json,
    });
    const operation = bulkOperationSchema.parse({
      id: '323e4567-e89b-42d3-a456-426614174000',
      type: 'bulk_change',
      status: 'launching',
      stateVersion: 1,
      launchAttempt: 1,
      initiatorId: '10',
      sourceOperationId: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      cancelRequestedAt: null,
      interruptionRequestedAt: null,
      interruptionReasonCode: null,
      summary: {
        selected: preview.summary.selected,
        eligible: preview.summary.eligible,
        excluded: preview.summary.excluded,
        unchanged: preview.summary.unchanged,
        successful: 0,
        failed: 0,
        unconfirmed: 0,
        conflicted: 0,
        partiallyApplied: 0,
        notProcessed: 0,
      },
    });
    vi.mocked(saved.repository.launchConfirmedTaskPreflight).mockResolvedValue({
      disposition: 'created',
      operation,
    });
    vi.mocked(saved.repository.readConfirmedOperationReceipt).mockResolvedValue(operation);
    const body = JSON.stringify({
      draftId: currentDraft.id,
      draftRevision: 4,
      checkedAt: preview.checkedAt,
      token: '223e4567-e89b-42d3-a456-426614174000',
    });
    const response = await saved.api.request(
      'https://example.test/api/tasks/preflight/launch',
      {
        method: 'POST',
        headers,
        body,
      },
      environment,
    );
    expect(response.status).toBe(200);
    expect(saved.repository.launchConfirmedTaskPreflight).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        token: '223e4567-e89b-42d3-a456-426614174000',
        preflightSnapshot: preview,
        encryptedPlan: expect.objectContaining({ keyVersion: 'v1' }),
      }),
    );
    vi.mocked(saved.repository.findOperationByLaunchKey).mockResolvedValue(operation);
    vi.mocked(saved.repository.getCurrentDraftForPreflight).mockClear();
    const replay = await saved.api.request(
      'https://example.test/api/tasks/preflight/launch',
      {
        method: 'POST',
        headers,
        body,
      },
      environment,
    );
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { id: string }).id).toBe(operation.id);
    expect(saved.repository.getCurrentDraftForPreflight).not.toHaveBeenCalled();
    expect(saved.repository.launchConfirmedTaskPreflight).toHaveBeenCalledTimes(1);
  });

  it('requires retry permission and returns an owner receipt after republishing the same operation', async () => {
    const forbidden = await setup();
    const operationId = '323e4567-e89b-42d3-a456-426614174000';
    const url = `https://example.test/api/tasks/operations/${operationId}/retry-launch`;
    const denied = await forbidden.api.request(
      url,
      { method: 'POST', headers, body: '{}' },
      environment,
    );
    expect(denied.status).toBe(403);
    expect(forbidden.repository.retryConfirmedOperationLaunch).not.toHaveBeenCalled();

    const authorized = await setup({
      permissions: [
        'app_access',
        'run_bulk_operations',
        'change_allowed_fields',
        'view_own_reports',
        'retry_operations',
      ],
    });
    const operation = bulkOperationSchema.parse({
      id: operationId,
      type: 'bulk_change',
      status: 'launching',
      stateVersion: 3,
      launchAttempt: 2,
      initiatorId: '10',
      sourceOperationId: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      cancelRequestedAt: null,
      interruptionRequestedAt: null,
      interruptionReasonCode: null,
      summary: {
        selected: 1,
        eligible: 1,
        excluded: 0,
        unchanged: 0,
        successful: 0,
        failed: 0,
        unconfirmed: 0,
        conflicted: 0,
        partiallyApplied: 0,
        notProcessed: 0,
      },
    });
    vi.mocked(authorized.repository.retryConfirmedOperationLaunch).mockResolvedValue({
      disposition: 'applied',
      operation,
    });
    vi.mocked(authorized.repository.readConfirmedOperationReceipt).mockResolvedValue(operation);
    vi.mocked(authorized.repository.claimOperationLaunchDispatch).mockResolvedValue({
      operation_id: operationId,
      portal_id: 'portal-1',
      launch_attempt: 2,
      message_id: '423e4567-e89b-42d3-a456-426614174000',
      status: 'sending',
      created_at: new Date().toISOString(),
      dispatched_at: null,
      claim_id: '523e4567-e89b-42d3-a456-426614174000',
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const published = await authorized.api.request(
      url,
      { method: 'POST', headers, body: '{}' },
      { ...environment, OPERATIONS_QUEUE: { send } as unknown as Queue },
    );
    expect(published.status).toBe(200);
    expect((await published.json()) as { id: string; launchAttempt: number }).toMatchObject({
      id: operationId,
      launchAttempt: 2,
    });
    expect(authorized.repository.retryConfirmedOperationLaunch).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ operationId, launchAttempt: 2 }));
    expect(authorized.repository.completeOperationLaunchDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ sent: true }),
    );
  });

  it('returns launch_failed after a retry publication error', async () => {
    const saved = await setup({
      permissions: [
        'app_access',
        'run_bulk_operations',
        'change_allowed_fields',
        'view_own_reports',
        'retry_operations',
      ],
    });
    const operationId = '323e4567-e89b-42d3-a456-426614174000';
    const operation = bulkOperationSchema.parse({
      id: operationId,
      type: 'bulk_change',
      status: 'launching',
      stateVersion: 3,
      launchAttempt: 2,
      initiatorId: '10',
      sourceOperationId: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      cancelRequestedAt: null,
      interruptionRequestedAt: null,
      interruptionReasonCode: null,
      summary: {
        selected: 1,
        eligible: 1,
        excluded: 0,
        unchanged: 0,
        successful: 0,
        failed: 0,
        unconfirmed: 0,
        conflicted: 0,
        partiallyApplied: 0,
        notProcessed: 0,
      },
    });
    vi.mocked(saved.repository.retryConfirmedOperationLaunch).mockResolvedValue({
      disposition: 'applied',
      operation,
    });
    vi.mocked(saved.repository.readConfirmedOperationReceipt).mockResolvedValue({
      ...operation,
      status: 'launch_failed',
      completedAt: new Date().toISOString(),
    });
    vi.mocked(saved.repository.claimOperationLaunchDispatch).mockResolvedValue({
      operation_id: operationId,
      portal_id: 'portal-1',
      launch_attempt: 2,
      message_id: '423e4567-e89b-42d3-a456-426614174000',
      status: 'sending',
      created_at: new Date().toISOString(),
      dispatched_at: null,
      claim_id: '523e4567-e89b-42d3-a456-426614174000',
    });
    const send = vi.fn().mockRejectedValue(new Error('Queue unavailable'));
    const response = await saved.api.request(
      `https://example.test/api/tasks/operations/${operationId}/retry-launch`,
      { method: 'POST', headers, body: '{}' },
      { ...environment, OPERATIONS_QUEUE: { send } as unknown as Queue },
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as { id: string; status: string }).toMatchObject({
      id: operationId,
      status: 'launch_failed',
    });
    expect(saved.repository.completeOperationLaunchDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ sent: false }),
    );
  });
  it('reads persisted owner progress and cancels without report permission', async () => {
    const fixture = await setup({ permissions: ['app_access', 'run_bulk_operations'] });
    const operation = bulkOperationSchema.parse({
      id: '323e4567-e89b-42d3-a456-426614174000',
      type: 'bulk_change',
      status: 'running',
      stateVersion: 4,
      launchAttempt: 1,
      initiatorId: '10',
      sourceOperationId: null,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: null,
      cancelRequestedAt: null,
      interruptionRequestedAt: null,
      interruptionReasonCode: null,
      summary: {
        selected: 5,
        eligible: 3,
        excluded: 1,
        unchanged: 1,
        successful: 1,
        failed: 0,
        unconfirmed: 1,
        conflicted: 0,
        partiallyApplied: 0,
        notProcessed: 0,
      },
    });
    vi.mocked(fixture.repository.getOwnedOperationProgress).mockResolvedValue(operation);
    vi.mocked(fixture.repository.getLatestOwnedOperationProgress).mockResolvedValue(operation);
    vi.mocked(fixture.repository.requestOperationCancellation).mockResolvedValue({
      operation: { ...operation, stateVersion: 5, cancelRequestedAt: new Date().toISOString() },
    });
    const current = await fixture.api.request(
      'https://example.test/api/tasks/operations/current/progress',
      { headers },
      environment,
    );
    expect(current.status).toBe(200);
    expect((await current.json()) as unknown).toMatchObject({
      progress: { processed: 2, remaining: 1, percent: 66 },
    });
    const cancelled = await fixture.api.request(
      `https://example.test/api/tasks/operations/${operation.id}/cancel`,
      { method: 'POST', headers, body: '{}' },
      environment,
    );
    expect(cancelled.status).toBe(200);
    expect((await cancelled.json()) as unknown).toMatchObject({
      operation: { stateVersion: 5 },
      processed: 2,
    });
    expect(fixture.repository.requestOperationCancellation).toHaveBeenCalledOnce();
  });

  it('rejects cancellation for a report viewer and does not expose another owner', async () => {
    const viewer = await setup({ permissions: ['app_access', 'view_own_reports'] });
    const cancelled = await viewer.api.request(
      'https://example.test/api/tasks/operations/323e4567-e89b-42d3-a456-426614174000/cancel',
      { method: 'POST', headers, body: '{}' },
      environment,
    );
    expect(cancelled.status).toBe(403);
    expect(viewer.repository.requestOperationCancellation).not.toHaveBeenCalled();
    vi.mocked(viewer.repository.getOwnedOperationProgress).mockRejectedValue(
      new DataAccessError('UNAVAILABLE_RECORD', false),
    );
    const progress = await viewer.api.request(
      'https://example.test/api/tasks/operations/323e4567-e89b-42d3-a456-426614174000/progress',
      { headers },
      environment,
    );
    expect(progress.status).toBe(404);
  });

  it('returns only a bounded owner result page with safe task metadata', async () => {
    const viewer = await setup({ permissions: ['app_access', 'view_own_reports'] });
    const operationId = '323e4567-e89b-42d3-a456-426614174000';
    vi.mocked(viewer.repository.listOwnedOperationProgressResults).mockResolvedValue({
      items: [
        {
          taskId: '42',
          title: 'Task',
          taskUrl: 'https://portal.bitrix24.ru/tasks/42',
          outcome: 'not_processed',
          changedFieldIds: [],
          appliedFieldIds: [],
          failedFieldIds: [],
          reasonCode: 'CANCELLED',
          reasonMessage: 'Операция остановлена.',
          canRetry: true,
          refinement: null,
        },
      ],
      nextCursor: null,
    });
    const response = await viewer.api.request(
      `https://example.test/api/tasks/operations/${operationId}/results?limit=20`,
      { headers },
      environment,
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toMatchObject({
      items: [{ taskId: '42', outcome: 'not_processed' }],
    });
    expect(viewer.repository.listOwnedOperationProgressResults).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: '10' }),
      operationId,
      { limit: 20 },
    );
    const invalid = await viewer.api.request(
      `https://example.test/api/tasks/operations/${operationId}/results?limit=101`,
      { headers },
      environment,
    );
    expect(invalid.status).toBe(400);
    expect(viewer.repository.listOwnedOperationProgressResults).toHaveBeenCalledTimes(1);
  });
});
