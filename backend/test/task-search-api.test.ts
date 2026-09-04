import { describe, expect, it, vi } from 'vitest';

import {
  apiErrorResponseSchema,
  taskSearchApiResponseSchema,
  type TaskSearchApiRequest,
} from '@task-commander/contracts';

import { createApi } from '../src/api';
import { resolveEffectiveAccess } from '../src/data/access';
import { ApiHttpError } from '../src/http/errors';
import type { BitrixAdapter, BitrixFailure } from '../src/integrations/bitrix/contract';
import { createMockBitrixAdapter } from '../src/integrations/bitrix/mock';
import { mockFixtureIds } from '../src/integrations/bitrix/mock/fixtures';
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
    }),
  });
}

function createAdapterWithTaskSearch(
  currentUserId: string,
  search: BitrixAdapter['tasks']['search'],
): BitrixAdapter {
  const adapter = createMockBitrixAdapter({ currentUserId });
  return { ...adapter, tasks: { ...adapter.tasks, search } };
}

async function postSearch(api: ReturnType<typeof createApi>, body: unknown = {}) {
  return api.request(
    'https://example.test/api/tasks/search',
    {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(body),
    },
    environment,
  );
}

describe('task search API', () => {
  it('applies defaults and returns only tasks readable by the signed current user', async () => {
    const principal = await createVerifiedTestPrincipal({ userId: '10' });
    const seenRequests: TaskSearchApiRequest[] = [];
    const api = createApi({
      readPrincipal: async () => principal,
      readEffectiveAccess: async () => createAppAccess(principal),
      createBitrixAdapter: (_env, input) => {
        const adapter = createMockBitrixAdapter({
          currentUserId: input.currentUserId,
          taskCount: 0,
        });
        return createAdapterWithTaskSearch(input.currentUserId, async (request) => {
          seenRequests.push(request);
          return adapter.tasks.search(request);
        });
      },
    });

    const response = await postSearch(api);
    const body = taskSearchApiResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('vary')).toContain('Cookie');
    expect(seenRequests).toEqual([
      {
        filters: [],
        sort: { fieldId: 'deadline', direction: 'asc' },
        page: 1,
        pageSize: 50,
      },
    ]);
    expect(body.items.some((task) => task.id === mockFixtureIds.hiddenTask)).toBe(false);
    expect(body.items.every((task) => task.relevantVersion.length > 0)).toBe(true);
    expect(body.items.every((task) => task.groupId !== null)).toBe(true);
    expect(body.items.every((task) => task.responsibleName !== null)).toBe(true);
  });

  it('uses the principal user ID when creating the search adapter', async () => {
    const principal = await createVerifiedTestPrincipal({ userId: '10' });
    const currentUserIds: string[] = [];
    const api = createApi({
      readPrincipal: async () => principal,
      readEffectiveAccess: async () => createAppAccess(principal),
      createBitrixAdapter: (_env, input) => {
        currentUserIds.push(input.currentUserId);
        return createMockBitrixAdapter({ currentUserId: input.currentUserId, taskCount: 0 });
      },
    });

    expect((await postSearch(api)).status).toBe(200);
    expect(currentUserIds).toEqual(['10', '10']);
  });

  it('denies application access before task search', async () => {
    const principal = await createVerifiedTestPrincipal({ userId: '10' });
    const search = vi.fn<BitrixAdapter['tasks']['search']>();
    const api = createApi({
      readPrincipal: async () => principal,
      readEffectiveAccess: async () => createAppAccess(principal, []),
      createBitrixAdapter: (_env, input) =>
        createAdapterWithTaskSearch(input.currentUserId, search),
    });

    const response = await postSearch(api);
    const body = apiErrorResponseSchema.parse(await response.json());

    expect(response.status).toBe(403);
    expect(body.error.code).toBe('FORBIDDEN');
    expect(search).not.toHaveBeenCalled();
  });

  it.each<[BitrixFailure, number, string]>([
    [{ kind: 'not_authenticated' }, 401, 'UNAUTHENTICATED'],
    [{ kind: 'permission_denied' }, 403, 'FORBIDDEN'],
    [{ kind: 'not_found_or_forbidden' }, 403, 'FORBIDDEN'],
    [{ kind: 'rate_limited', limit: 'intensity', retryAt: null }, 429, 'RATE_LIMITED'],
    [{ kind: 'temporary_failure', reasonCode: 'timeout' }, 503, 'UPSTREAM_UNAVAILABLE'],
    [
      { kind: 'permanent_failure', reasonCode: 'invalid_filter', fieldIds: ['deadline'] },
      503,
      'UPSTREAM_UNAVAILABLE',
    ],
    [{ kind: 'invalid_external_response' }, 503, 'UPSTREAM_UNAVAILABLE'],
    [{ kind: 'unsupported_capability', capability: 'task_search' }, 503, 'UPSTREAM_UNAVAILABLE'],
  ])('maps adapter failure %# to a safe API error', async (failure, status, code) => {
    const principal = await createVerifiedTestPrincipal({ userId: '10' });
    const api = createApi({
      readPrincipal: async () => principal,
      readEffectiveAccess: async () => createAppAccess(principal),
      createBitrixAdapter: (_env, input) =>
        createAdapterWithTaskSearch(input.currentUserId, async () => ({ ok: false, failure })),
    });

    const response = await postSearch(api);
    const responseText = await response.clone().text();
    const body = apiErrorResponseSchema.parse(await response.json());

    expect(response.status).toBe(status);
    expect(body.error.code).toBe(code);
    expect(responseText).not.toContain('invalid_filter');
  });

  it('rejects malformed successful adapter output as unavailable', async () => {
    const principal = await createVerifiedTestPrincipal({ userId: '10' });
    const api = createApi({
      readPrincipal: async () => principal,
      readEffectiveAccess: async () => createAppAccess(principal),
      createBitrixAdapter: (_env, input) =>
        createAdapterWithTaskSearch(input.currentUserId, async () => ({
          ok: true,
          value: { items: [{ id: '42' }], total: 1, hasNextPage: false },
        }) as never),
    });

    const response = await postSearch(api);
    const body = apiErrorResponseSchema.parse(await response.json());

    expect(response.status).toBe(503);
    expect(body.error.code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('rejects an adapter page containing more rows than the requested page size', async () => {
    const principal = await createVerifiedTestPrincipal({ userId: '10' });
    const source = createMockBitrixAdapter({ currentUserId: principal.userId, taskCount: 30 });
    const api = createApi({
      readPrincipal: async () => principal,
      readEffectiveAccess: async () => createAppAccess(principal),
      createBitrixAdapter: (_env, input) =>
        createAdapterWithTaskSearch(input.currentUserId, async (request) => {
          const sourcePage = await source.tasks.search({ ...request, pageSize: 50 });
          if (!sourcePage.ok) return sourcePage;
          return {
            ok: true,
            value: {
              items: sourcePage.value.items.slice(0, 30),
              total: 30,
              hasNextPage: false,
            },
          };
        }),
    });

    const response = await postSearch(api, { page: 1, pageSize: 25 });
    const body = apiErrorResponseSchema.parse(await response.json());

    expect(response.status).toBe(503);
    expect(body.error.code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('maps an unexpected adapter exception to unavailable', async () => {
    const principal = await createVerifiedTestPrincipal({ userId: '10' });
    const api = createApi({
      readPrincipal: async () => principal,
      readEffectiveAccess: async () => createAppAccess(principal),
      createBitrixAdapter: (_env, input) =>
        createAdapterWithTaskSearch(input.currentUserId, async () => {
          throw new Error('sensitive upstream failure');
        }),
    });

    const response = await postSearch(api);
    const responseText = await response.clone().text();
    const body = apiErrorResponseSchema.parse(await response.json());

    expect(response.status).toBe(503);
    expect(body.error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(responseText).not.toContain('sensitive upstream failure');
  });

  it('rejects semantically invalid filters before adapter search', async () => {
    const principal = await createVerifiedTestPrincipal({ userId: '10' });
    const search = vi.fn<BitrixAdapter['tasks']['search']>();
    const api = createApi({
      readPrincipal: async () => principal,
      readEffectiveAccess: async () => createAppAccess(principal),
      createBitrixAdapter: (_env, input) =>
        createAdapterWithTaskSearch(input.currentUserId, search),
    });

    const response = await postSearch(api, {
      filters: [{ kind: 'date_time', fieldId: 'deadline', operator: 'between', values: [] }],
    });

    expect(response.status).toBe(400);
    expect(search).not.toHaveBeenCalled();
  });

  it('rejects field-kind mismatches and unknown sort fields before adapter search', async () => {
    const principal = await createVerifiedTestPrincipal({ userId: '10' });
    const search = vi.fn<BitrixAdapter['tasks']['search']>();
    const api = createApi({
      readPrincipal: async () => principal,
      readEffectiveAccess: async () => createAppAccess(principal),
      createBitrixAdapter: (_env, input) =>
        createAdapterWithTaskSearch(input.currentUserId, search),
    });

    const mismatch = await postSearch(api, {
      filters: [{ kind: 'text', fieldId: 'deadline', operator: 'equals', values: ['today'] }],
    });
    const unknownSort = await postSearch(api, {
      sort: { fieldId: 'missing', direction: 'asc' },
    });

    expect(mismatch.status).toBe(400);
    expect(unknownSort.status).toBe(400);
    expect(search).not.toHaveBeenCalled();
  });

  it('rejects option values absent from the current field catalog', async () => {
    const principal = await createVerifiedTestPrincipal({ userId: '10' });
    const search = vi.fn<BitrixAdapter['tasks']['search']>();
    const api = createApi({
      readPrincipal: async () => principal,
      readEffectiveAccess: async () => createAppAccess(principal),
      createBitrixAdapter: (_env, input) =>
        createAdapterWithTaskSearch(input.currentUserId, search),
    });

    const response = await postSearch(api, {
      filters: [
        { kind: 'list', fieldId: 'priority', operator: 'equals', values: ['removed-option'] },
      ],
    });

    expect(response.status).toBe(400);
    expect(search).not.toHaveBeenCalled();
  });

  it('maps field-capability failures before adapter search', async () => {
    const principal = await createVerifiedTestPrincipal({ userId: '10' });
    const search = vi.fn<BitrixAdapter['tasks']['search']>();
    const api = createApi({
      readPrincipal: async () => principal,
      readEffectiveAccess: async () => createAppAccess(principal),
      createBitrixAdapter: (_env, input) => {
        const adapter = createAdapterWithTaskSearch(input.currentUserId, search);
        return {
          ...adapter,
          tasks: {
            ...adapter.tasks,
            getFieldCapabilities: async () => ({
              ok: false as const,
              failure: { kind: 'temporary_failure' as const, reasonCode: 'sensitive' },
            }),
          },
        };
      },
    });

    const response = await postSearch(api);
    const responseText = await response.clone().text();

    expect(response.status).toBe(503);
    expect(responseText).not.toContain('sensitive');
    expect(search).not.toHaveBeenCalled();
  });

  it('authenticates before exposing request validation details', async () => {
    const search = vi.fn<BitrixAdapter['tasks']['search']>();
    const api = createApi({
      readPrincipal: async () => {
        throw new ApiHttpError(401, 'UNAUTHENTICATED');
      },
      createBitrixAdapter: (_env, input) =>
        createAdapterWithTaskSearch(input.currentUserId, search),
    });

    const response = await postSearch(api, {
      filters: [{ kind: 'date_time', fieldId: 'deadline', operator: 'between', values: [] }],
    });
    const body = apiErrorResponseSchema.parse(await response.json());

    expect(response.status).toBe(401);
    expect(body.error.code).toBe('UNAUTHENTICATED');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('vary')).toContain('Cookie');
    expect(response.headers.get('x-correlation-id')).toBe(body.error.correlationId);
    expect(response.headers.get('content-security-policy')).toContain("object-src 'none'");
    expect(search).not.toHaveBeenCalled();
  });
});
