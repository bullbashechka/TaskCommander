import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { router } from '@/app/router';

const capabilities = {
  actor: { id: '1', displayName: 'Кирилл Сайдашев', isAdministrator: true },
  manageablePermissions: [
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
  permissionMatrixVersion: 1,
};

const users = {
  checkedAt: '2026-08-13T10:00:00.000Z',
  employees: [
    {
      userId: '10',
      displayName: 'Анна Смирнова',
      employmentState: 'active',
      isBitrixAdmin: false,
      isManager: true,
      jobTitle: 'Руководитель проектов',
      departmentName: 'Маркетинг',
      avatarUrl: null,
      accessState: 'active',
      accessVersion: 1,
      permissionCount: 2,
      fieldScope: { kind: 'all' },
    },
    {
      userId: '11',
      displayName: 'Иван Петров',
      employmentState: 'active',
      isBitrixAdmin: true,
      isManager: false,
      jobTitle: 'Администратор',
      departmentName: 'Компания',
      avatarUrl: null,
      accessState: 'active',
      accessVersion: null,
      permissionCount: 10,
      fieldScope: { kind: 'all' },
    },
  ],
  nextCursor: null,
};

function response(value: unknown) {
  return Promise.resolve(new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
}

async function renderAccessPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await router.navigate({ to: '/access' });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await screen.findByRole('heading', { name: 'Управление доступом' });
}

describe('access selection screen', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/capabilities')) return response(capabilities);
      if (url.includes('/departments')) return response({ items: [] });
      return response(users);
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('keeps the bulk CTA hidden until an editable employee is selected', async () => {
    await renderAccessPage();

    expect(screen.getByRole('button', { name: 'Настроить' })).toBeVisible();
    expect(screen.queryByRole('link', { name: /Настроить доступ для/ })).toBeNull();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Выбрать: Анна Смирнова' }));

    expect(screen.getByRole('link', { name: 'Настроить доступ для 1 сотрудника' })).toBeVisible();
    expect(screen.getByText('Выбрано: 1')).toBeVisible();
  });

  it('exposes semantic selection, filter, and immutable administrator states', async () => {
    await renderAccessPage();

    expect(screen.getByRole('link', { name: 'Доступ' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Все' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('checkbox', { name: 'Выбрать: Иван Петров' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Выбрать всех сотрудников на странице' })).toBeEnabled();
  });

  it('opens the keyboard-managed department dialog', async () => {
    await renderAccessPage();

    fireEvent.click(screen.getByRole('button', { name: 'Добавить подразделение' }));

    expect(await screen.findByRole('dialog', { name: 'Добавить подразделение' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Отмена' })).toBeEnabled();
  });
});
