import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AppApiError,
  createLocalDevSession,
  createSavedTaskFilter,
  deleteSavedTaskFilter,
  fetchTaskFilterCatalog,
  searchTasks,
  updateSavedTaskFilter,
} from './app-api';
import { notifySecurityContextInvalidated } from './access-sync';

vi.mock('./access-sync', () => ({ notifySecurityContextInvalidated: vi.fn() }));

const correlationId = 'TC-123e4567-e89b-42d3-a456-426614174000';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('local developer session API', () => {
  it('posts only the fixed local administrator ID and accepts an empty success response', async () => {
    const request = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return Promise.resolve(
        new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } }),
      );
    });
    vi.stubGlobal('fetch', request);

    await expect(createLocalDevSession()).resolves.toBeUndefined();

    const call = request.mock.calls[0];
    expect(call?.[0]).toBe('/api/_dev/session');
    const init = call?.[1] as RequestInit | undefined;
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ userId: '1' }));
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
  });

  it('preserves a safe local endpoint error without parsing it as a success response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        void input;
        void init;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: 'NOT_FOUND',
                message: 'Маршрут API не найден.',
                correlationId,
              },
            }),
            { status: 404, headers: { 'content-type': 'application/json' } },
          ),
        );
      }),
    );

    const request = createLocalDevSession();
    await expect(request).rejects.toBeInstanceOf(AppApiError);
    await expect(request).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      eventId: correlationId,
    });
  });
});

describe('task filter API client', () => {
  it('serializes search and owner-safe saved-filter mutations', async () => {
    const saved = {
      id: 'da94a81c-9d88-4ce4-97d4-d94cbe225d42',
      name: 'Срочные',
      revision: 1,
      filters: [],
      createdAt: '2026-09-04T10:00:00Z',
      updatedAt: '2026-09-04T10:00:00Z',
    };
    const request = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const status = init?.method === 'DELETE' ? 204 : 200;
      const payload =
        String(input) === '/api/tasks/search'
          ? { items: [], total: 0, page: 1, pageSize: 50, hasNextPage: false }
          : saved;
      return Promise.resolve(
        new Response(status === 204 ? null : JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    vi.stubGlobal('fetch', request);

    await searchTasks({
      filters: [],
      sort: { fieldId: 'deadline', direction: 'asc' },
      page: 1,
      pageSize: 50,
    });
    await createSavedTaskFilter({ name: 'Срочные', filters: [] });
    await updateSavedTaskFilter({ ...saved, name: 'Сегодня' });
    await deleteSavedTaskFilter(saved);

    expect(request.mock.calls.map((call) => call[0])).toEqual([
      '/api/tasks/search',
      '/api/tasks/saved-filters',
      `/api/tasks/saved-filters/${saved.id}`,
      `/api/tasks/saved-filters/${saved.id}`,
    ]);
    expect((request.mock.calls[0]?.[1] as RequestInit).method).toBe('POST');
    expect((request.mock.calls[2]?.[1] as RequestInit).body).toBe(
      JSON.stringify({ name: 'Сегодня', expectedRevision: 1 }),
    );
    expect((request.mock.calls[3]?.[1] as RequestInit).body).toBe(
      JSON.stringify({ expectedRevision: 1 }),
    );
  });

  it('deduplicates terminal security invalidations until a successful response', async () => {
    const terminalResponse = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              code: 'ACCESS_REVOKED',
              message: 'Доступ отозван.',
              correlationId,
            },
          }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        ),
      );
    const unauthenticatedResponse = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              code: 'UNAUTHENTICATED',
              message: 'Требуется сессия.',
              correlationId,
            },
          }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
      );
    const successResponse = () =>
      Promise.resolve(
        new Response(JSON.stringify({ version: 1, fields: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const request = vi
      .fn()
      .mockImplementationOnce(unauthenticatedResponse)
      .mockImplementationOnce(terminalResponse)
      .mockImplementationOnce(successResponse)
      .mockImplementationOnce(terminalResponse);
    vi.stubGlobal('fetch', request);

    await expect(fetchTaskFilterCatalog()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(fetchTaskFilterCatalog()).rejects.toMatchObject({ code: 'ACCESS_REVOKED' });
    expect(notifySecurityContextInvalidated).toHaveBeenCalledTimes(1);

    await expect(fetchTaskFilterCatalog()).resolves.toEqual({ version: 1, fields: [] });
    await expect(fetchTaskFilterCatalog()).rejects.toMatchObject({ code: 'ACCESS_REVOKED' });
    expect(notifySecurityContextInvalidated).toHaveBeenCalledTimes(2);
  });
});
