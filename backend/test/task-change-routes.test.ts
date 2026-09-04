import { describe, expect, it, vi } from 'vitest';

import {
  bulkOperationDraftAvailabilitySchema,
  bulkOperationDraftSchema,
  taskChangeCatalogResponseSchema,
  preflightPreviewSchema,
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
  ACCESS_FANOUT_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
};

const headers = {
  origin: 'https://example.test',
  'sec-fetch-site': 'same-origin',
  cookie: 'tc_session=test',
  'content-type': 'application/json',
};

async function setup(input?: {
  permissions?: ('app_access' | 'run_bulk_operations' | 'change_allowed_fields')[];
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
  const repository: TaskChangeRepository = {
    ensurePrincipalIdentity: vi.fn(),
    getCurrentDraft,
    getCurrentDraftForPreflight,
    saveDraft,
    saveTaskPreflight,
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
    adapterFactory,
    getCurrentDraft,
    getCurrentDraftForPreflight,
    saveDraft,
    saveTaskPreflight,
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
});
