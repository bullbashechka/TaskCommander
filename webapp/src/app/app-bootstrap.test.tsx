import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { AppApiError } from './app-api';
import { AppBootstrap, isLocalDevLoginEnabled } from './app-bootstrap';

const correlationId = 'TC-123e4567-e89b-42d3-a456-426614174000';
const administrator = {
  portalId: 'local-demo',
  userId: '1',
  displayName: 'Portal administrator',
  isBitrixAdmin: true,
};
const administratorAccess = {
  permissions: [
    'app_access',
    'run_bulk_operations',
    'change_allowed_fields',
    'retry_operations',
    'restore_operations',
    'view_own_reports',
    'view_all_reports',
    'export_reports',
    'view_audit',
    'manage_access',
  ],
  fieldScope: { kind: 'all' },
};

class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];

  public onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  public readonly postMessage = vi.fn();
  public readonly close = vi.fn();

  public constructor(public readonly name: string) {
    FakeBroadcastChannel.instances.push(this);
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function apiErrorResponse(code: 'UNAUTHENTICATED' | 'FORBIDDEN', status: number): Response {
  return jsonResponse(
    {
      error: {
        code,
        message: 'Безопасная ошибка.',
        correlationId,
      },
    },
    status,
  );
}

function renderBootstrap() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AppBootstrap queryClient={queryClient}>
        {(snapshot) => <div>{`ready:${snapshot.principal.userId}`}</div>}
      </AppBootstrap>
    </QueryClientProvider>,
  );
  return queryClient;
}

afterEach(() => {
  cleanup();
  FakeBroadcastChannel.instances = [];
  vi.unstubAllGlobals();
});

describe('local developer login bootstrap', () => {
  it('shows the local entry action only for a development session-required error', () => {
    expect(isLocalDevLoginEnabled(true, new AppApiError('x', 'session_required'))).toBe(true);
    expect(isLocalDevLoginEnabled(false, new AppApiError('x', 'session_required'))).toBe(false);
    expect(isLocalDevLoginEnabled(true, new AppApiError('x', 'access_denied'))).toBe(false);
  });

  it('creates one local session and renders only after fresh session and access checks', async () => {
    class ThrowingBroadcastChannel {
      public constructor() {
        throw new Error('channel unavailable');
      }
    }
    vi.stubGlobal('BroadcastChannel', ThrowingBroadcastChannel);
    let sessionRequests = 0;
    const requestOrder: string[] = [];
    const request = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const path = String(input);
      requestOrder.push(path);
      if (path === '/api/session') {
        sessionRequests += 1;
        return Promise.resolve(
          sessionRequests === 1
            ? apiErrorResponse('UNAUTHENTICATED', 401)
            : jsonResponse({ principal: administrator }),
        );
      }
      if (path === '/api/_dev/session') {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (path === '/api/access') return Promise.resolve(jsonResponse(administratorAccess));
      if (path === '/api/access-management/capabilities') {
        return Promise.resolve(jsonResponse({ canManageAccess: true }));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', request);

    renderBootstrap();

    const button = await screen.findByRole('button', { name: 'Войти локально' });
    fireEvent.click(button);
    fireEvent.click(button);

    expect((screen.getByRole('button', { name: 'Входим…' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(await screen.findByText('ready:1')).toBeTruthy();

    const localLoginCalls = request.mock.calls.filter(([path]) => path === '/api/_dev/session');
    expect(localLoginCalls).toHaveLength(1);
    const init = localLoginCalls[0]?.[1] as RequestInit | undefined;
    expect(init?.body).toBe(JSON.stringify({ userId: '1' }));
    expect(sessionRequests).toBe(2);
    expect(requestOrder).toEqual([
      '/api/session',
      '/api/_dev/session',
      '/api/session',
      '/api/access',
      '/api/access-management/capabilities',
    ]);
  });

  it('hides the previous security context immediately during cross-tab revalidation', async () => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const path = String(input);
        if (path === '/api/session')
          return Promise.resolve(jsonResponse({ principal: administrator }));
        if (path === '/api/access') return Promise.resolve(jsonResponse(administratorAccess));
        if (path === '/api/access-management/capabilities') {
          return Promise.resolve(jsonResponse({ canManageAccess: true }));
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );

    const queryClient = renderBootstrap();
    expect(await screen.findByText('ready:1')).toBeTruthy();

    let finishCancellation: (() => void) | undefined;
    const cancellation = new Promise<void>((resolve) => {
      finishCancellation = resolve;
    });
    vi.spyOn(queryClient, 'cancelQueries').mockReturnValue(cancellation);

    act(() => {
      for (const channel of FakeBroadcastChannel.instances) {
        channel.onmessage?.(
          new MessageEvent('message', {
            data: { sourceId: 'another-tab', type: 'security-context-invalidated' },
          }),
        );
      }
    });

    expect(await screen.findByRole('heading', { name: 'Проверяем доступ…' })).toBeTruthy();
    expect(screen.queryByText('ready:1')).toBeNull();

    await act(async () => {
      finishCancellation?.();
      await cancellation;
    });
    expect(await screen.findByText('ready:1')).toBeTruthy();
  });

  it('keeps the local action hidden for an access denial', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(apiErrorResponse('FORBIDDEN', 403))),
    );

    renderBootstrap();

    await screen.findByRole('heading', { name: 'Доступ к Task Commander закрыт' });
    expect(screen.queryByRole('button', { name: 'Войти локально' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Повторить проверку' })).toBeTruthy();
  });

  it('keeps the action available with a safe message when the local endpoint is unavailable', async () => {
    const request = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      if (String(input) === '/api/session') {
        return Promise.resolve(apiErrorResponse('UNAUTHENTICATED', 401));
      }
      if (String(input) === '/api/_dev/session') {
        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: 'NOT_FOUND',
                message: 'Маршрут API не найден.',
                correlationId,
              },
            },
            404,
          ),
        );
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal('fetch', request);

    renderBootstrap();

    fireEvent.click(await screen.findByRole('button', { name: 'Войти локально' }));
    await screen.findByRole('heading', { name: 'Локальный вход недоступен' });
    expect(
      (screen.getByRole('button', { name: 'Войти локально' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
