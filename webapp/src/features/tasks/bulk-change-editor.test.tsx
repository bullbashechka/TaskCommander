import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TaskChangeCatalogResponse } from '@task-commander/contracts';

import {
  AppApiError,
  fetchTaskChangeCatalog,
  saveBulkOperationDraft,
  searchTaskFilterUsers,
} from '@/app/app-api';
import { AppAccessProvider, type AppAccessSnapshot } from '@/app/app-context';

import { BulkChangeEditor } from './bulk-change-editor';

vi.mock('@/app/app-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/app-api')>()),
  fetchTaskChangeCatalog: vi.fn(),
  saveBulkOperationDraft: vi.fn(),
  searchTaskFilterUsers: vi.fn(),
}));

const catalog: TaskChangeCatalogResponse = {
  version: 1,
  fields: [
    {
      id: 'title',
      label: 'Название',
      kind: 'text',
      isMultiple: false,
      isNullable: false,
      valueSource: 'text',
      options: [],
      actions: ['set'],
    },
    {
      id: 'status',
      label: 'Статус',
      kind: 'list',
      isMultiple: false,
      isNullable: false,
      valueSource: 'options',
      options: [
        { value: 'pending', label: 'Ждёт выполнения' },
        { value: 'in_progress', label: 'Выполняется' },
      ],
      actions: ['set'],
    },
    {
      id: 'tags',
      label: 'Теги',
      kind: 'tags',
      isMultiple: true,
      isNullable: true,
      valueSource: 'text',
      options: [],
      actions: ['replace', 'add', 'remove', 'clear'],
    },
    {
      id: 'UF_TASK_APPROVED',
      label: 'Согласовано',
      kind: 'boolean',
      isMultiple: false,
      isNullable: false,
      valueSource: 'boolean',
      options: [],
      actions: ['set'],
    },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function accessSnapshot(fieldIds: string[]): AppAccessSnapshot {
  return {
    principal: {
      portalId: 'portal.test',
      userId: '10',
      displayName: 'Тестовый пользователь',
      isBitrixAdmin: false,
    },
    access: {
      permissions: ['app_access', 'run_bulk_operations', 'change_allowed_fields'],
      fieldScope: { kind: 'subset', fieldIds },
    },
    accessManagement: 'denied',
    generation: 1,
    canMutate: true,
  };
}

function renderEditor(options?: { app?: AppAccessSnapshot; onBack?: () => void }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const editor = (
    <BulkChangeEditor
      filters={[]}
      initialDraft={null}
      initialRevision={0}
      onBack={options?.onBack ?? vi.fn()}
      onSaved={vi.fn()}
      replaceExpired
      selectedTaskIds={['42', '43']}
      sort={{ fieldId: 'deadline', direction: 'asc' }}
    />
  );
  const view = render(
    <QueryClientProvider client={queryClient}>
      {options?.app ? <AppAccessProvider value={options.app}>{editor}</AppAccessProvider> : editor}
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

describe('bulk change editor', () => {
  beforeEach(() => {
    vi.mocked(fetchTaskChangeCatalog).mockResolvedValue(catalog);
    vi.mocked(searchTaskFilterUsers).mockResolvedValue({ items: [], nextCursor: null });
    vi.mocked(saveBulkOperationDraft).mockResolvedValue({
      id: '123e4567-e89b-42d3-a456-426614174000',
      ownerId: '10',
      revision: 1,
      status: 'preparing',
      filters: [],
      sort: { fieldId: 'deadline', direction: 'asc' },
      selectedTaskIds: ['42', '43'],
      changes: [
        { fieldId: 'title', kind: 'text', action: 'set', value: 'Новый заголовок' },
        { fieldId: 'tags', kind: 'tags', action: 'replace', values: ['release', 'urgent'] },
      ],
      createdAt: '2026-09-04T10:00:00Z',
      updatedAt: '2026-09-04T10:00:00Z',
      expiresAt: '2026-09-05T10:00:00Z',
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('builds and saves multiple field changes', async () => {
    renderEditor();
    await screen.findByRole('heading', { name: 'Настройка изменений' });

    fireEvent.change(screen.getByRole('combobox', { name: 'Добавить поле' }), {
      target: { value: 'title' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Значение' }), {
      target: { value: 'Новый заголовок' },
    });

    fireEvent.change(screen.getByRole('combobox', { name: 'Добавить поле' }), {
      target: { value: 'tags' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Значения через запятую' }), {
      target: { value: 'release, urgent' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить черновик' }));

    await waitFor(() =>
      expect(saveBulkOperationDraft).toHaveBeenCalledWith({
        expectedRevision: 0,
        replaceExpired: true,
        selectedTaskIds: ['42', '43'],
        filters: [],
        sort: { fieldId: 'deadline', direction: 'asc' },
        changes: [
          { fieldId: 'title', kind: 'text', action: 'set', value: 'Новый заголовок' },
          { fieldId: 'tags', kind: 'tags', action: 'replace', values: ['release', 'urgent'] },
        ],
      }),
    );
    expect(await screen.findByText('Черновик сохранён на 24 часа.')).toBeInTheDocument();
  });

  it('does not expose completed status or forbidden actions', async () => {
    renderEditor();
    await screen.findByRole('heading', { name: 'Настройка изменений' });
    const fieldSelect = screen.getByRole('combobox', { name: 'Добавить поле' });

    expect(
      within(fieldSelect).queryByRole('option', { name: /вложен|файл|комментар/i }),
    ).toBeNull();
    fireEvent.change(fieldSelect, { target: { value: 'status' } });
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));
    const valueSelect = screen.getByRole('combobox', { name: 'Значение' });
    expect(within(valueSelect).queryByRole('option', { name: /заверш/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /удалить зада/i })).toBeNull();
  });

  it('shows revoked access before loading the catalog and keeps a back action', async () => {
    const onBack = vi.fn();
    const current = accessSnapshot(['title']);
    const denied: AppAccessSnapshot = {
      ...current,
      access: { ...current.access, permissions: ['app_access'] },
    };
    renderEditor({ app: denied, onBack });

    expect(await screen.findByText('Настройка изменений недоступна')).toBeInTheDocument();
    expect(fetchTaskChangeCatalog).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Назад к задачам' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('keeps the draft unsaved when a required value is empty', async () => {
    renderEditor();
    await screen.findByRole('heading', { name: 'Настройка изменений' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Добавить поле' }), {
      target: { value: 'title' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить черновик' }));

    const error = await screen.findByText('Укажите допустимое значение.');
    expect(error).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Значение' })).toHaveAttribute(
      'aria-describedby',
      error.id,
    );
    expect(screen.getByRole('textbox', { name: 'Значение' })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(saveBulkOperationDraft).not.toHaveBeenCalled();
  });

  it('requires an explicit boolean value and saves false without coercion', async () => {
    renderEditor();
    await screen.findByRole('heading', { name: 'Настройка изменений' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Добавить поле' }), {
      target: { value: 'UF_TASK_APPROVED' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить черновик' }));

    const value = screen.getByRole('combobox', { name: 'Значение' });
    expect(await screen.findByText('Укажите допустимое значение.')).toBeInTheDocument();
    expect(value).toHaveAttribute('aria-invalid', 'true');
    expect(saveBulkOperationDraft).not.toHaveBeenCalled();

    fireEvent.change(value, { target: { value: 'false' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить черновик' }));

    await waitFor(() =>
      expect(saveBulkOperationDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          changes: [{ fieldId: 'UF_TASK_APPROVED', kind: 'boolean', action: 'set', value: false }],
        }),
      ),
    );
  });

  it('does not show a stale save as current after edits made during the request', async () => {
    const pending = deferred<Awaited<ReturnType<typeof saveBulkOperationDraft>>>();
    vi.mocked(saveBulkOperationDraft).mockReturnValueOnce(pending.promise);
    renderEditor();
    await screen.findByRole('heading', { name: 'Настройка изменений' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Добавить поле' }), {
      target: { value: 'title' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));
    const value = screen.getByRole('textbox', { name: 'Значение' });
    fireEvent.change(value, { target: { value: 'Сохранённая версия' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить черновик' }));
    await waitFor(() => expect(saveBulkOperationDraft).toHaveBeenCalledTimes(1));

    fireEvent.change(value, { target: { value: 'Новая несохранённая версия' } });
    await act(async () => {
      pending.resolve({
        id: '123e4567-e89b-42d3-a456-426614174000',
        ownerId: '10',
        revision: 1,
        status: 'preparing',
        filters: [],
        sort: { fieldId: 'deadline', direction: 'asc' },
        selectedTaskIds: ['42', '43'],
        changes: [{ fieldId: 'title', kind: 'text', action: 'set', value: 'Сохранённая версия' }],
        createdAt: '2026-09-04T10:00:00Z',
        updatedAt: '2026-09-04T10:00:00Z',
        expiresAt: '2026-09-05T10:00:00Z',
      });
      await pending.promise;
    });

    expect(screen.queryByText('Черновик сохранён на 24 часа.')).not.toBeInTheDocument();
    expect(value).toHaveValue('Новая несохранённая версия');
  });

  it('invalidates the cached draft after a revision conflict', async () => {
    vi.mocked(saveBulkOperationDraft).mockRejectedValueOnce(
      new AppApiError('Conflict', 'internal', 409, 'CONFLICT'),
    );
    const { queryClient } = renderEditor();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await screen.findByRole('heading', { name: 'Настройка изменений' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Добавить поле' }), {
      target: { value: 'title' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Значение' }), {
      target: { value: 'Конфликтующая версия' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить черновик' }));

    expect(await screen.findByText(/Черновик изменён в другой вкладке/)).toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['bulk-operation-draft'] });
  });

  it('reloads the catalog and removes a field when the scope changes at the same generation', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const editor = (app: AppAccessSnapshot) => (
      <QueryClientProvider client={queryClient}>
        <AppAccessProvider value={app}>
          <BulkChangeEditor
            filters={[]}
            initialDraft={null}
            initialRevision={0}
            onBack={vi.fn()}
            onSaved={vi.fn()}
            replaceExpired
            selectedTaskIds={['42']}
            sort={{ fieldId: 'deadline', direction: 'asc' }}
          />
        </AppAccessProvider>
      </QueryClientProvider>
    );
    const view = render(editor(accessSnapshot(['title', 'tags'])));
    await screen.findByRole('heading', { name: 'Настройка изменений' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Добавить поле' }), {
      target: { value: 'title' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));

    vi.mocked(fetchTaskChangeCatalog).mockResolvedValueOnce({
      version: 1,
      fields: catalog.fields.filter((field) => field.id === 'tags'),
    });
    view.rerender(editor(accessSnapshot(['tags'])));

    expect(
      await screen.findByText(
        'Схема доступа изменилась. Недоступные или несовместимые настройки удалены.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Название/ })).toBeNull();
  });
});
