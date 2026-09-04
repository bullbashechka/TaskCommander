import { describe, expect, it, vi } from 'vitest';

import { apiErrorResponseSchema, taskSelectAllApiResponseSchema } from '@task-commander/contracts';

import { createApi } from '../src/api';
import { resolveEffectiveAccess } from '../src/data/access';
import { ApiHttpError } from '../src/http/errors';
import type { BitrixAdapter, BitrixFailure } from '../src/integrations/bitrix/contract';
import { createMockBitrixAdapter } from '../src/integrations/bitrix/mock';
import { createVerifiedTestPrincipal } from './verified-session-test-helper';

const environment = {
  APP_ENV: 'local',
  APP_ORIGIN: 'https://example.test',
  BITRIX_PORTAL_ORIGIN: 'https://portal.bitrix24.ru',
};

const requestHeaders = {
  'content-type': 'application/json',
  origin: 'https://example.test',
  'sec-fetch-site': 'same-origin',
  cookie: 'tc_session=test',
};

async function createAppAccess(
  principal: Awaited<ReturnType<typeof createVerifiedTestPrincipal>>,
  permissions: ['app_access'] | [] = ['app_access'],
) {
  return resolveEffectiveAccess(principal, {
    findEffectiveAccessSettings: async () => ({
      accessActive: true,
      permissions,
      allowedFieldIds: [],
      accessVersion: 1,
    }),
  });
}

function createAdapterWithTaskSelection(
  currentUserId: string,
  selectAll: BitrixAdapter['tasks']['selectAll'],
  taskCount = 0,
): BitrixAdapter {
  const adapter = createMockBitrixAdapter({ currentUserId, taskCount });
  return { ...adapter, tasks: { ...adapter.tasks, selectAll } };
}

async function postSelectAll(api: ReturnType<typeof createApi>, body: unknown = {}) {
  return api.request(
    'https://example.test/api/tasks/select-all',
    {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(body),
    },
    environment,
  );
}

describe('task select-all API', () => {
  it.each([
    ['empty', 0, 'empty', 0],
    ['at the limit', 993, 'selected', 1_000],
    ['over the limit', 994, 'too_many', 1_001],
  ] as const)('returns %s authoritative outcome', async (_name, taskCount, kind, total) => {
    const principal = await createVerifiedTestPrincipal({ userId: '10' });
    const api = createApi({
      readPrincipal: async () => principal,
      readEffectiveAccess: async () => createAppAccess(principal),
      createBitrixAdapter: (_env, input) =>
        createMockBitrixAdapter({ currentUserId: input.currentUserId, taskCount }),
    });

    const response = await postSelectAll(
      api,
      taskCount === 0
        ? {
            filters: [
              {
                kind: 'text',
                fieldId: 'title',
                operator: 'contains',
                values: ['not-present-in-any-task'],
              },
            ],
          }
        : {},
    );
    const body = taskSelectAllApiResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ kind, total });
    if (body.kind === 'selected') {
      expect(body.taskIds).toHaveLength(total);
      expect(new Set(body.taskIds).size).toBe(total);
    }
  });

  it('authenticates and authorizes before resolving the selection', async () => {
    const selectAll = vi.fn<BitrixAdapter['tasks']['selectAll']>();
    const unauthenticatedApi = createApi({
      readPrincipal: async () => {
        throw new ApiHttpError(401, 'UNAUTHENTICATED');
      },
      createBitrixAdapter: (_env, input) =>
        createAdapterWithTaskSelection(input.currentUserId, selectAll),
    });
    const unauthenticated = await postSelectAll(unauthenticatedApi);

    const principal = await createVerifiedTestPrincipal({ userId: '10' });
    const unauthorizedApi = createApi({
      readPrincipal: async () => principal,
      readEffectiveAccess: async () => createAppAccess(principal, []),
      createBitrixAdapter: (_env, input) =>
        createAdapterWithTaskSelection(input.currentUserId, selectAll),
    });
    const unauthorized = await postSelectAll(unauthorizedApi);

    expect(unauthenticated.status).toBe(401);
    expect(apiErrorResponseSchema.parse(await unauthenticated.json()).error.code).toBe(
      'UNAUTHENTICATED',
    );
    expect(unauthorized.status).toBe(403);
    expect(apiErrorResponseSchema.parse(await unauthorized.json()).error.code).toBe('FORBIDDEN');
    expect(selectAll).not.toHaveBeenCalled();
  });

  it('rejects client totals, task IDs, malformed filters, and duplicate filters before selection', async () => {
    const principal = await createVerifiedTestPrincipal({ userId: '10' });
    const selectAll = vi.fn<BitrixAdapter['tasks']['selectAll']>();
    const api = createApi({
      readPrincipal: async () => principal,
      readEffectiveAccess: async () => createAppAccess(principal),
      createBitrixAdapter: (_env, input) =>
        createAdapterWithTaskSelection(input.currentUserId, selectAll),
    });

    const clientValues = await postSelectAll(api, { taskIds: ['42'], total: 1 });
    const malformed = await postSelectAll(api, {
      filters: [{ kind: 'date_time', fieldId: 'deadline', operator: 'between', values: [] }],
    });
    const duplicates = await postSelectAll(api, {
      filters: [
        { kind: 'text', fieldId: 'title', operator: 'contains', values: ['one'] },
        { kind: 'text', fieldId: 'title', operator: 'contains', values: ['two'] },
      ],
    });

    expect(clientValues.status).toBe(400);
    expect(malformed.status).toBe(400);
    expect(duplicates.status).toBe(400);
    expect(selectAll).not.toHaveBeenCalled();
  });

  it('returns safe upstream errors and rejects malformed selection results', async () => {
    const principal = await createVerifiedTestPrincipal({ userId: '10' });
    const failure: BitrixFailure = {
      kind: 'temporary_failure',
      reasonCode: 'sensitive-upstream-diagnostic',
    };
    const failedApi = createApi({
      readPrincipal: async () => principal,
      readEffectiveAccess: async () => createAppAccess(principal),
      createBitrixAdapter: (_env, input) =>
        createAdapterWithTaskSelection(input.currentUserId, async () => ({ ok: false, failure })),
    });
    const failed = await postSelectAll(failedApi);
    const failedText = await failed.clone().text();

    const malformedApi = createApi({
      readPrincipal: async () => principal,
      readEffectiveAccess: async () => createAppAccess(principal),
      createBitrixAdapter: (_env, input) =>
        createAdapterWithTaskSelection(input.currentUserId, async () => ({
          ok: true,
          value: { kind: 'selected', taskIds: ['42', '42'], total: 2 },
        })),
    });
    const malformed = await postSelectAll(malformedApi);

    expect(failed.status).toBe(503);
    expect(apiErrorResponseSchema.parse(await failed.json()).error.code).toBe(
      'UPSTREAM_UNAVAILABLE',
    );
    expect(failedText).not.toContain('sensitive-upstream-diagnostic');
    expect(malformed.status).toBe(503);
    expect(apiErrorResponseSchema.parse(await malformed.json()).error.code).toBe(
      'UPSTREAM_UNAVAILABLE',
    );
  });
});
