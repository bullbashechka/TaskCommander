import { describe, expect, it, vi } from 'vitest';

import {
  bulkOperationDraftAvailabilitySchema,
  bulkOperationDraftSchema,
  taskChangeCatalogResponseSchema,
} from '@task-commander/contracts';

import { createApi } from '../src/api';
import { resolveEffectiveAccess } from '../src/data/access';
import { DataAccessError } from '../src/data/errors';
import { createMockBitrixAdapter } from '../src/integrations/bitrix/mock';
import type { TaskChangeRepository } from '../src/task-changes/routes';
import { createVerifiedTestPrincipal } from './verified-session-test-helper';

const environment = {
  APP_ENV: 'local',
  APP_ORIGIN: 'https://example.test',
  BITRIX_PORTAL_ORIGIN: 'https://portal.bitrix24.ru',
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
    }),
  });
  const getCurrentDraft = vi.fn<TaskChangeRepository['getCurrentDraft']>().mockResolvedValue(null);
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
  const repository: TaskChangeRepository = {
    ensurePrincipalIdentity: vi.fn(),
    getCurrentDraft,
    saveDraft,
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
    readEffectiveAccess: async () => access,
    createBitrixAdapter: adapterFactory,
    createTaskChangeRepository: () => repository,
  });
  return { api, adapterFactory, getCurrentDraft, saveDraft };
}

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
});
