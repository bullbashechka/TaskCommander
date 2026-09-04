import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppAccessProvider, type AppAccessSnapshot } from '@/app/app-context';
import { router } from '@/app/router';

const app: AppAccessSnapshot = {
  principal: {
    portalId: 'portal.test',
    userId: '42',
    displayName: 'Тестовый пользователь',
    isBitrixAdmin: false,
  },
  access: {
    permissions: ['app_access', 'run_bulk_operations', 'view_own_reports'],
    fieldScope: { kind: 'all' },
  },
  accessManagement: 'denied',
  generation: 0,
  canMutate: true,
};

function installCompactMediaQuery() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(max-width: 1179px)',
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

async function renderShell() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await router.navigate({ to: '/' });
  render(
    <QueryClientProvider client={queryClient}>
      <AppAccessProvider value={app}>
        <RouterProvider context={{ app, queryClient }} router={router} />
      </AppAccessProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('compact application navigation', () => {
  it('opens from the keyboard and closes with Escape while restoring focus', async () => {
    installCompactMediaQuery();
    await renderShell();

    const trigger = screen.getByRole('button', { name: 'Задачи' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('link', { name: 'Task Commander — Главная' })).toBeVisible();

    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    const taskLink = screen.getByRole('link', { name: 'Массовое изменение' });
    taskLink.focus();
    fireEvent.keyDown(taskLink, { key: 'Escape' });

    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
  });

  it('marks the active child, closes after navigation, and focuses the page heading', async () => {
    installCompactMediaQuery();
    await renderShell();

    const trigger = screen.getByRole('button', { name: 'Задачи' });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('link', { name: 'Массовое изменение' }));

    const heading = await screen.findByRole('heading', { name: 'Массовое изменение' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(trigger);
    expect(screen.getByRole('link', { name: 'Массовое изменение' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});
