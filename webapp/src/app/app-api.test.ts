import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppApiError, createLocalDevSession } from './app-api';

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
