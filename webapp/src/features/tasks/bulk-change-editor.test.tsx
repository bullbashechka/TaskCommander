import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PreflightPreview, TaskChangeCatalogResponse } from '@task-commander/contracts';

import {
  AppApiError,
  createTaskPreflight,
  fetchTaskChangeCatalog,
  getBulkOperationDraft,
  saveBulkOperationDraft,
  searchTaskFilterUsers,
} from '@/app/app-api';
import { AppAccessProvider, type AppAccessSnapshot } from '@/app/app-context';

import { BulkChangeEditor } from './bulk-change-editor';

vi.mock('@/app/app-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/app-api')>()),
  fetchTaskChangeCatalog: vi.fn(),
  createTaskPreflight: vi.fn(),
  getBulkOperationDraft: vi.fn(),
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

function previewResult(sourceDraftRevision: number): PreflightPreview {
  return {
    draftId: '123e4567-e89b-42d3-a456-426614174000',
    draftRevision: sourceDraftRevision + 1,
    sourceDraftRevision,
    actorAccessVersion: null,
    checkedAt: new Date().toISOString(),
    canProceed: true,
    entries: [
      {
        taskId: '42',
        title: 'Задача 42',
        taskUrl: null,
        disposition: 'eligible',
        changedFieldIds: ['title'],
        reasonCode: null,
        reasonMessage: null,
        relevantVersion: 'v1',
        currentValues: { title: 'Старое' },
        targetValues: { title: 'Новое' },
      },
      {
        taskId: '43',
        title: null,
        taskUrl: null,
        disposition: 'excluded_by_preflight',
        changedFieldIds: [],
        reasonCode: 'TASK_UNAVAILABLE',
        reasonMessage: 'Задача недоступна.',
        relevantVersion: null,
        currentValues: null,
        targetValues: null,
      },
    ],
    summary: {
      selected: 2,
      eligible: 1,
      excluded: 1,
      unchanged: 0,
      successful: 0,
      failed: 0,
      unconfirmed: 0,
      conflicted: 0,
      partiallyApplied: 0,
      notProcessed: 0,
    },
  };
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
  const wrap = (app?: AppAccessSnapshot) => (
    <QueryClientProvider client={queryClient}>
      {app ? <AppAccessProvider value={app}>{editor}</AppAccessProvider> : editor}
    </QueryClientProvider>
  );
  const view = render(wrap(options?.app));
  return {
    ...view,
    queryClient,
    updateAccess: (app: AppAccessSnapshot) => view.rerender(wrap(app)),
  };
}

describe('bulk change editor', () => {
  beforeEach(() => {
    vi.mocked(fetchTaskChangeCatalog).mockResolvedValue(catalog);
    vi.mocked(getBulkOperationDraft).mockResolvedValue({ draft: null });
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

  it('discards a late preflight response after the editor changes', async () => {
    const pending = deferred<PreflightPreview>();
    vi.mocked(createTaskPreflight).mockReturnValue(pending.promise);
    renderEditor();
    await screen.findByRole('heading', { name: 'Настройка изменений' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Добавить поле' }), {
      target: { value: 'title' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Значение' }), {
      target: { value: 'Новое название' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Проверить изменения' }));
    await waitFor(() =>
      expect(createTaskPreflight).toHaveBeenCalledWith({
        draftId: '123e4567-e89b-42d3-a456-426614174000',
        expectedRevision: 1,
      }),
    );
    const saveButton = screen.getByRole('button', { name: 'Сохранить черновик' });
    expect(saveButton).toBeDisabled();
    fireEvent.submit(saveButton.closest('form')!);
    expect(saveBulkOperationDraft).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByRole('textbox', { name: 'Значение' }), {
      target: { value: 'Ещё одно название' },
    });
    await act(async () => {
      pending.resolve(previewResult(1));
      await pending.promise;
    });
    expect(screen.getByRole('heading', { name: 'Настройка изменений' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Предварительный просмотр' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Проверить изменения' }));
    await waitFor(() =>
      expect(saveBulkOperationDraft).toHaveBeenLastCalledWith(
        expect.objectContaining({ expectedRevision: 2 }),
      ),
    );
  });

  it('uses the preflight revision after returning from preview to edit again', async () => {
    vi.mocked(saveBulkOperationDraft).mockImplementation(async (request) => ({
      id: '123e4567-e89b-42d3-a456-426614174000',
      ownerId: '10',
      revision: request.expectedRevision + 1,
      status: 'preparing',
      filters: request.filters,
      sort: request.sort,
      selectedTaskIds: request.selectedTaskIds,
      changes: request.changes,
      createdAt: '2026-09-04T10:00:00Z',
      updatedAt: '2026-09-04T10:00:00Z',
      expiresAt: '2026-09-05T10:00:00Z',
    }));
    vi.mocked(createTaskPreflight)
      .mockResolvedValueOnce(previewResult(1))
      .mockResolvedValueOnce(previewResult(3));
    renderEditor();
    await screen.findByRole('heading', { name: 'Настройка изменений' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Добавить поле' }), {
      target: { value: 'title' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Значение' }), {
      target: { value: 'Новое' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Проверить изменения' }));
    expect(await screen.findByRole('heading', { name: 'Предварительный просмотр' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Вернуться к настройке' }));
    expect(await screen.findByRole('heading', { name: 'Настройка изменений' })).toHaveFocus();
    fireEvent.change(screen.getByRole('textbox', { name: 'Значение' }), {
      target: { value: 'Другое' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Проверить изменения' }));
    await waitFor(() =>
      expect(saveBulkOperationDraft).toHaveBeenLastCalledWith(
        expect.objectContaining({ expectedRevision: 2 }),
      ),
    );
  });

  it('replays an uncertain preflight without saving the draft again', async () => {
    vi.mocked(createTaskPreflight)
      .mockRejectedValueOnce(new AppApiError('Timeout', 'temporary'))
      .mockRejectedValueOnce(new AppApiError('Timeout', 'temporary'))
      .mockResolvedValueOnce(previewResult(1));
    renderEditor();
    await screen.findByRole('heading', { name: 'Настройка изменений' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Добавить поле' }), {
      target: { value: 'title' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Значение' }), {
      target: { value: 'Новое' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Проверить изменения' }));
    await waitFor(() => expect(createTaskPreflight).toHaveBeenCalledTimes(2));
    await screen.findByText('Не удалось проверить задачи. Повторите действие.');
    fireEvent.click(screen.getByRole('button', { name: 'Проверить изменения' }));
    await screen.findByRole('heading', { name: 'Предварительный просмотр' });
    expect(saveBulkOperationDraft).toHaveBeenCalledTimes(1);
    expect(createTaskPreflight).toHaveBeenCalledTimes(3);
    expect(createTaskPreflight).toHaveBeenNthCalledWith(3, {
      draftId: '123e4567-e89b-42d3-a456-426614174000',
      expectedRevision: 1,
    });
  });

  it('recovers an uncertain save after its result appears on the server', async () => {
    vi.mocked(saveBulkOperationDraft).mockRejectedValueOnce(
      new AppApiError('Timeout', 'temporary'),
    );
    vi.mocked(getBulkOperationDraft)
      .mockResolvedValueOnce({ draft: null })
      .mockResolvedValueOnce({
        draft: {
          id: '123e4567-e89b-42d3-a456-426614174000',
          ownerId: '10',
          revision: 1,
          status: 'preparing',
          filters: [],
          sort: { fieldId: 'deadline', direction: 'asc' },
          selectedTaskIds: ['42', '43'],
          changes: [{ fieldId: 'title', kind: 'text', action: 'set', value: 'Новое' }],
          createdAt: '2026-09-04T10:00:00Z',
          updatedAt: '2026-09-04T10:00:00Z',
          expiresAt: '2026-09-05T10:00:00Z',
        },
      });
    vi.mocked(createTaskPreflight).mockResolvedValue(previewResult(1));
    renderEditor();
    await screen.findByRole('heading', { name: 'Настройка изменений' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Добавить поле' }), {
      target: { value: 'title' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Значение' }), {
      target: { value: 'Новое' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Проверить изменения' }));
    await screen.findByText('Не удалось проверить задачи. Повторите действие.');
    fireEvent.click(screen.getByRole('button', { name: 'Проверить изменения' }));
    await screen.findByRole('heading', { name: 'Предварительный просмотр' });
    expect(saveBulkOperationDraft).toHaveBeenCalledTimes(1);
    expect(getBulkOperationDraft).toHaveBeenCalledTimes(2);
    expect(createTaskPreflight).toHaveBeenCalledWith({
      draftId: '123e4567-e89b-42d3-a456-426614174000',
      expectedRevision: 1,
    });
  });

  it('ignores a late preflight response after the session generation changes', async () => {
    const pending = deferred<PreflightPreview>();
    vi.mocked(createTaskPreflight).mockReturnValue(pending.promise);
    const app = accessSnapshot(['title']);
    const editor = renderEditor({ app });
    await screen.findByRole('heading', { name: 'Настройка изменений' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Добавить поле' }), {
      target: { value: 'title' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Значение' }), {
      target: { value: 'Новое' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Проверить изменения' }));
    await waitFor(() => expect(createTaskPreflight).toHaveBeenCalledTimes(1));
    editor.updateAccess({ ...app, generation: 2 });
    await act(async () => {
      pending.resolve(previewResult(1));
      await pending.promise;
    });
    expect(screen.queryByRole('heading', { name: 'Предварительный просмотр' })).toBeNull();
    expect(screen.getByText(/Права изменились/)).toBeInTheDocument();
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
