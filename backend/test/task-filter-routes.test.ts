import { describe, expect, it, vi } from 'vitest';

import {
  apiErrorResponseSchema,
  savedTaskFilterListResponseSchema,
  savedTaskFilterSchema,
  taskFilterCatalogResponseSchema,
  taskFilterUserSearchResponseSchema,
} from '@task-commander/contracts';

import { createApi } from '../src/api';
import type { DataAccessContext } from '../src/data/access';
import { resolveEffectiveAccess } from '../src/data/access';
import { DataAccessError } from '../src/data/errors';
import type { SavedFilter } from '../src/data/repositories';
import { createMockBitrixAdapter } from '../src/integrations/bitrix/mock';
import type { TaskFilterRepository } from '../src/task-filters/routes';
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

async function createDependencies() {
  const principal = await createVerifiedTestPrincipal({ userId: '10' });
  return {
    principal,
    base: {
      readPrincipal: async () => principal,
      readEffectiveAccess: async () => createAppAccess(principal),
      createBitrixAdapter: (_env: unknown, input: { currentUserId: string }) =>
        createMockBitrixAdapter({ currentUserId: input.currentUserId }),
    },
  };
}

describe('task filter routes', () => {
  it('returns the versioned catalog to an ordinary application user', async () => {
    const { base } = await createDependencies();
    const response = await createApi(base).request(
      'https://example.test/api/tasks/fields',
      { headers },
      environment,
    );
    const body = taskFilterCatalogResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('vary')).toContain('Cookie');
    expect(body.fields.find((field) => field.id === 'responsible_id')).toMatchObject({
      label: 'Исполнитель',
      kind: 'user',
      valueSource: 'users',
    });
  });

  it('returns only minimal active employee data for participant pickers', async () => {
    const { base } = await createDependencies();
    const response = await createApi(base).request(
      'https://example.test/api/tasks/users?q=Opera&pageSize=10',
      { headers },
      environment,
    );
    const body = taskFilterUserSearchResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(body.items.length).toBeGreaterThan(0);
    expect(Object.keys(body.items[0]!).sort()).toEqual(['displayName', 'id']);
  });

  it.each(['fields', 'users'] as const)(
    'maps unexpected %s adapter exceptions to unavailable',
    async (endpoint) => {
      const { base } = await createDependencies();
      const api = createApi({
        ...base,
        createBitrixAdapter: (_env, input) => {
          const adapter = createMockBitrixAdapter({ currentUserId: input.currentUserId });
          return endpoint === 'fields'
            ? {
                ...adapter,
                tasks: {
                  ...adapter.tasks,
                  getFieldCapabilities: async () => {
                    throw new Error('sensitive capability failure');
                  },
                },
              }
            : {
                ...adapter,
                users: {
                  ...adapter.users,
                  searchEmployees: async () => {
                    throw new Error('sensitive directory failure');
                  },
                },
              };
        },
      });
      const response = await api.request(
        `https://example.test/api/tasks/${endpoint}`,
        { headers },
        environment,
      );
      const responseText = await response.clone().text();

      expect(response.status).toBe(503);
      expect(responseText).not.toContain('sensitive');
    },
  );

  it('rejects inactive employees returned against the adapter contract', async () => {
    const { base } = await createDependencies();
    const api = createApi({
      ...base,
      createBitrixAdapter: (_env, input) => {
        const adapter = createMockBitrixAdapter({ currentUserId: input.currentUserId });
        return {
          ...adapter,
          users: {
            ...adapter.users,
            searchEmployees: async () => ({
              ok: true as const,
              value: {
                items: [
                  {
                    id: '99',
                    displayName: 'Inactive employee',
                    isActive: false,
                    isAdmin: false,
                    departmentIds: [],
                    email: null,
                    position: null,
                    photoUrl: null,
                    profileUrl: null,
                  },
                ],
                total: 1,
                nextCursor: null,
              },
            }),
          },
        };
      },
    });
    const response = await api.request(
      'https://example.test/api/tasks/users?q=inactive',
      { headers },
      environment,
    );

    expect(response.status).toBe(503);
  });

  it('rejects duplicate employees and pages larger than requested', async () => {
    const { base } = await createDependencies();
    const firstEmployee = {
      id: '99',
      displayName: 'Duplicate employee',
      isActive: true,
      isAdmin: false,
      departmentIds: [],
      email: null,
      position: null,
      photoUrl: null,
      profileUrl: null,
    };
    const secondEmployee = { ...firstEmployee, id: '100', displayName: 'Second employee' };
    const api = createApi({
      ...base,
      createBitrixAdapter: (_env, input) => {
        const adapter = createMockBitrixAdapter({ currentUserId: input.currentUserId });
        return {
          ...adapter,
          users: {
            ...adapter.users,
            searchEmployees: async (request) => ({
              ok: true as const,
              value: {
                items:
                  request.pageSize === 1
                    ? [firstEmployee, secondEmployee]
                    : [firstEmployee, firstEmployee],
                total: 2,
                nextCursor: null,
              },
            }),
          },
        };
      },
    });
    const oversizedResponse = await api.request(
      'https://example.test/api/tasks/users?pageSize=1',
      { headers },
      environment,
    );
    const duplicateResponse = await api.request(
      'https://example.test/api/tasks/users?pageSize=2',
      { headers },
      environment,
    );

    expect(oversizedResponse.status).toBe(503);
    expect(duplicateResponse.status).toBe(503);
  });

  it('persists CRUD through the owner-scoped data context', async () => {
    const { base, principal } = await createDependencies();
    const contexts: DataAccessContext[] = [];
    let row: SavedFilter = {
      id: 'da94a81c-9d88-4ce4-97d4-d94cbe225d42',
      name: 'Мои задачи',
      revision: 1,
      filterPayload: [],
      createdAt: '2026-09-04T10:00:00Z',
      updatedAt: '2026-09-04T10:00:00Z',
    };
    const repository: TaskFilterRepository = {
      ensurePrincipalIdentity: vi.fn(),
      listSavedFilters: vi.fn(async (context: DataAccessContext) => {
        contexts.push(context);
        return [row];
      }),
      createSavedFilter: vi.fn(async (context, input) => {
        contexts.push(context);
        row = { ...row, name: input.name, filterPayload: input.filterPayload };
        return row;
      }),
      updateSavedFilter: vi.fn(async (context, input) => {
        contexts.push(context);
        row = { ...row, name: input.name, revision: 2 };
        return row;
      }),
      deleteSavedFilter: vi.fn(async (context: DataAccessContext) => {
        contexts.push(context);
      }),
    };
    const api = createApi({ ...base, createTaskFilterRepository: () => repository });

    const createdResponse = await api.request(
      'https://example.test/api/tasks/saved-filters',
      {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '  Срочные  ',
          filters: [{ kind: 'list', fieldId: 'priority', operator: 'equals', values: ['high'] }],
        }),
      },
      environment,
    );
    const created = savedTaskFilterSchema.parse(await createdResponse.json());
    const listedResponse = await api.request(
      'https://example.test/api/tasks/saved-filters',
      { headers },
      environment,
    );
    const listed = savedTaskFilterListResponseSchema.parse(await listedResponse.json());
    const updatedResponse = await api.request(
      `https://example.test/api/tasks/saved-filters/${created.id}`,
      {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Сегодня', expectedRevision: 1 }),
      },
      environment,
    );
    const updated = savedTaskFilterSchema.parse(await updatedResponse.json());
    const deletedResponse = await api.request(
      `https://example.test/api/tasks/saved-filters/${created.id}`,
      {
        method: 'DELETE',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: 2 }),
      },
      environment,
    );

    expect(createdResponse.status).toBe(201);
    expect(created.name).toBe('Срочные');
    expect(listed.items).toHaveLength(1);
    expect(updated.name).toBe('Сегодня');
    expect(updated.filters).toEqual(created.filters);
    expect(deletedResponse.status).toBe(204);
    expect(contexts.every((context) => context.actorId === principal.userId)).toBe(true);
    expect(contexts.every((context) => context.portalId === principal.portalId)).toBe(true);
  });

  it('rejects a semantically invalid saved filter before writing it', async () => {
    const { base } = await createDependencies();
    const createSavedFilter = vi.fn();
    const repository = {
      ensurePrincipalIdentity: vi.fn(),
      listSavedFilters: vi.fn(),
      createSavedFilter,
      updateSavedFilter: vi.fn(),
      deleteSavedFilter: vi.fn(),
    } satisfies TaskFilterRepository;
    const api = createApi({ ...base, createTaskFilterRepository: () => repository });

    const response = await api.request(
      'https://example.test/api/tasks/saved-filters',
      {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Broken',
          filters: [{ kind: 'text', fieldId: 'deadline', operator: 'equals', values: ['today'] }],
        }),
      },
      environment,
    );

    expect(response.status).toBe(400);
    expect(createSavedFilter).not.toHaveBeenCalled();
  });

  it('creates a non-authorizing identity row for an administrator only before first write', async () => {
    const principal = await createVerifiedTestPrincipal({
      userId: '1',
      displayName: 'Portal administrator',
      isBitrixAdmin: true,
    });
    const ensurePrincipalIdentity = vi.fn();
    const repository = {
      ensurePrincipalIdentity,
      listSavedFilters: vi.fn(async () => []),
      createSavedFilter: vi.fn(async () => ({
        id: 'da94a81c-9d88-4ce4-97d4-d94cbe225d42',
        name: 'Admin filter',
        revision: 1,
        filterPayload: [],
        createdAt: '2026-09-04T10:00:00Z',
        updatedAt: '2026-09-04T10:00:00Z',
      })),
      updateSavedFilter: vi.fn(),
      deleteSavedFilter: vi.fn(),
    } satisfies TaskFilterRepository;
    const api = createApi({
      readPrincipal: async () => principal,
      readEffectiveAccess: async () => createAppAccess(principal),
      createBitrixAdapter: (_env, input) =>
        createMockBitrixAdapter({ currentUserId: input.currentUserId }),
      createTaskFilterRepository: () => repository,
    });

    const readResponse = await api.request(
      'https://example.test/api/tasks/saved-filters',
      { headers },
      environment,
    );
    expect(readResponse.status).toBe(200);
    expect(ensurePrincipalIdentity).not.toHaveBeenCalled();

    const invalidResponse = await api.request(
      'https://example.test/api/tasks/saved-filters',
      {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ name: '', filters: [] }),
      },
      environment,
    );
    expect(invalidResponse.status).toBe(400);
    expect(ensurePrincipalIdentity).not.toHaveBeenCalled();

    const response = await api.request(
      'https://example.test/api/tasks/saved-filters',
      {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Admin filter', filters: [] }),
      },
      environment,
    );

    expect(response.status).toBe(201);
    expect(ensurePrincipalIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ portalId: principal.portalId, actorId: principal.userId }),
      principal.displayName,
    );
  });

  it('does not reach saved-filter storage without application access', async () => {
    const { base, principal } = await createDependencies();
    const listSavedFilters = vi.fn();
    const api = createApi({
      ...base,
      readEffectiveAccess: async () => createAppAccess(principal, []),
      createTaskFilterRepository: () => ({ listSavedFilters }) as never,
    });
    const response = await api.request(
      'https://example.test/api/tasks/saved-filters',
      { headers },
      environment,
    );

    expect(response.status).toBe(403);
    expect(listSavedFilters).not.toHaveBeenCalled();
  });

  it.each([
    [new DataAccessError('CONFLICT', false), 409, 'CONFLICT'],
    [new DataAccessError('SAVED_FILTER_LIMIT', false), 409, 'SAVED_FILTER_LIMIT'],
    [new DataAccessError('SAVED_FILTER_NAME_TAKEN', false), 409, 'SAVED_FILTER_NAME_TAKEN'],
    [new DataAccessError('UNAVAILABLE_RECORD', false), 404, 'NOT_FOUND'],
    [new DataAccessError('UNAVAILABLE', true), 503, 'UPSTREAM_UNAVAILABLE'],
  ] as const)('maps storage failures without exposing details', async (failure, status, code) => {
    const { base } = await createDependencies();
    const api = createApi({
      ...base,
      createTaskFilterRepository: () =>
        ({
          listSavedFilters: async () => {
            throw failure;
          },
        }) as never,
    });
    const response = await api.request(
      'https://example.test/api/tasks/saved-filters',
      { headers },
      environment,
    );
    const body = apiErrorResponseSchema.parse(await response.json());

    expect(response.status).toBe(status);
    expect(body.error.code).toBe(code);
  });

  it('rejects out-of-range saved-filter revisions before storage access', async () => {
    const { base } = await createDependencies();
    const updateSavedFilter = vi.fn();
    const deleteSavedFilter = vi.fn();
    const api = createApi({
      ...base,
      createTaskFilterRepository: () => ({ updateSavedFilter, deleteSavedFilter }) as never,
    });
    const filterId = 'da94a81c-9d88-4ce4-97d4-d94cbe225d42';
    const update = await api.request(
      `https://example.test/api/tasks/saved-filters/${filterId}`,
      {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Too new', expectedRevision: 2_147_483_647 }),
      },
      environment,
    );
    const deletion = await api.request(
      `https://example.test/api/tasks/saved-filters/${filterId}`,
      {
        method: 'DELETE',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: 1e100 }),
      },
      environment,
    );

    expect(update.status).toBe(400);
    expect(deletion.status).toBe(400);
    expect(updateSavedFilter).not.toHaveBeenCalled();
    expect(deleteSavedFilter).not.toHaveBeenCalled();
  });

  it('rejects malformed persisted payloads as unavailable', async () => {
    const { base } = await createDependencies();
    const api = createApi({
      ...base,
      createTaskFilterRepository: () =>
        ({
          listSavedFilters: async () => [
            {
              id: 'da94a81c-9d88-4ce4-97d4-d94cbe225d42',
              name: 'Broken',
              revision: 1,
              filterPayload: [{ secret: 'must-not-leak' }],
              createdAt: '2026-09-04T10:00:00Z',
              updatedAt: '2026-09-04T10:00:00Z',
            },
          ],
        }) as never,
    });
    const response = await api.request(
      'https://example.test/api/tasks/saved-filters',
      { headers },
      environment,
    );
    const responseText = await response.clone().text();

    expect(response.status).toBe(503);
    expect(responseText).not.toContain('secret');
  });

  it('returns structurally valid saved filters so stale entries can still be renamed or deleted', async () => {
    const { base } = await createDependencies();
    const api = createApi({
      ...base,
      createTaskFilterRepository: () =>
        ({
          listSavedFilters: async () => [
            {
              id: 'da94a81c-9d88-4ce4-97d4-d94cbe225d42',
              name: 'Old priority',
              revision: 1,
              filterPayload: [
                {
                  kind: 'list',
                  fieldId: 'priority',
                  operator: 'equals',
                  values: ['removed-option'],
                },
              ],
              createdAt: '2026-09-04T10:00:00Z',
              updatedAt: '2026-09-04T10:00:00Z',
            },
          ],
        }) as never,
    });

    const response = await api.request(
      'https://example.test/api/tasks/saved-filters',
      { headers },
      environment,
    );

    const body = savedTaskFilterListResponseSchema.parse(await response.json());
    expect(response.status).toBe(200);
    expect(body.items[0]?.name).toBe('Old priority');
  });
});
