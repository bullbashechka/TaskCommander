import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  SavedTaskFilter,
  TaskFilterCatalogResponse,
  TaskSearchItem,
} from '@task-commander/contracts';

import {
  AppApiError,
  createSavedTaskFilter,
  deleteSavedTaskFilter,
  fetchTaskChangeCatalog,
  fetchTaskFilterCatalog,
  getBulkOperationDraft,
  listSavedTaskFilters,
  selectAllTasks,
  searchTaskFilterUsers,
  searchTasks,
  saveBulkOperationDraft,
  updateSavedTaskFilter,
} from '@/app/app-api';
import { AppAccessProvider, type AppAccessSnapshot } from '@/app/app-context';

import { TaskFiltersPage } from './task-filters-page';

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
}));

vi.mock('@/app/app-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/app-api')>()),
  createSavedTaskFilter: vi.fn(),
  deleteSavedTaskFilter: vi.fn(),
  fetchTaskChangeCatalog: vi.fn(),
  fetchTaskFilterCatalog: vi.fn(),
  getBulkOperationDraft: vi.fn(),
  listSavedTaskFilters: vi.fn(),
  selectAllTasks: vi.fn(),
  searchTaskFilterUsers: vi.fn(),
  searchTasks: vi.fn(),
  saveBulkOperationDraft: vi.fn(),
  updateSavedTaskFilter: vi.fn(),
}));

const catalog: TaskFilterCatalogResponse = {
  version: 1,
  fields: [
    {
      id: 'title',
      label: 'Название',
      kind: 'text',
      isMultiple: false,
      isNullable: false,
      sortable: true,
      operators: ['contains', 'not_contains', 'equals', 'not_equals', 'is_set', 'is_not_set'],
      valueSource: 'text',
      options: [],
    },
    {
      id: 'deadline',
      label: 'Крайний срок',
      kind: 'date_time',
      isMultiple: false,
      isNullable: true,
      sortable: true,
      operators: ['equals', 'before', 'after', 'between', 'is_set', 'is_not_set'],
      valueSource: 'date_time',
      options: [],
    },
    {
      id: 'priority',
      label: 'Приоритет',
      kind: 'list',
      isMultiple: false,
      isNullable: false,
      sortable: true,
      operators: ['includes', 'not_includes', 'equals', 'not_equals', 'is_set', 'is_not_set'],
      valueSource: 'options',
      options: [
        { value: 'normal', label: 'Обычный' },
        { value: 'high', label: 'Высокий' },
      ],
    },
  ],
};

const changeCatalog = {
  version: 1 as const,
  fields: [
    {
      id: 'title',
      label: 'Название',
      kind: 'text' as const,
      isMultiple: false,
      isNullable: false,
      valueSource: 'text' as const,
      options: [],
      actions: ['set' as const],
    },
  ],
};

const appSnapshot: AppAccessSnapshot = {
  principal: {
    portalId: 'portal.test',
    userId: '10',
    displayName: 'Тестовый пользователь',
    isBitrixAdmin: false,
  },
  access: {
    permissions: ['app_access', 'run_bulk_operations', 'change_allowed_fields'],
    fieldScope: { kind: 'subset', fieldIds: ['title'] },
  },
  accessManagement: 'denied',
  generation: 1,
  canMutate: true,
};

const saved: SavedTaskFilter = {
  id: 'da94a81c-9d88-4ce4-97d4-d94cbe225d42',
  name: 'Срочные',
  revision: 1,
  filters: [{ kind: 'list', fieldId: 'priority', operator: 'equals', values: ['high'] }],
  createdAt: '2026-09-04T10:00:00Z',
  updatedAt: '2026-09-04T10:00:00Z',
};

const firstTask: TaskSearchItem = {
  id: '42',
  title: 'Подготовить квартальный отчёт',
  taskUrl: 'https://portal.bitrix24.ru/company/personal/user/10/tasks/task/view/42/',
  parentId: null,
  groupId: '1',
  status: 'in_progress',
  responsibleId: '10',
  responsibleName: 'Иван Петров',
  deadline: '2026-08-14T05:00:00Z',
  priority: 'high',
  relevantVersion: 'version-42',
};

const secondTask: TaskSearchItem = {
  ...firstTask,
  id: '43',
  title: 'Согласовать квартальный отчёт',
  taskUrl: 'https://portal.bitrix24.ru/company/personal/user/10/tasks/task/view/43/',
  relevantVersion: 'version-43',
};

const firstPageTasks: TaskSearchItem[] = [
  firstTask,
  ...Array.from({ length: 49 }, (_, index) => {
    const id = String(100 + index);
    return {
      ...firstTask,
      id,
      title: `Задача первой страницы ${index + 2}`,
      taskUrl: `https://portal.bitrix24.ru/company/personal/user/10/tasks/task/view/${id}/`,
      relevantVersion: `version-${id}`,
    };
  }),
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function renderPage(app?: AppAccessSnapshot) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const page = app ? (
    <AppAccessProvider value={app}>
      <TaskFiltersPage />
    </AppAccessProvider>
  ) : (
    <TaskFiltersPage />
  );
  return render(<QueryClientProvider client={queryClient}>{page}</QueryClientProvider>);
}

describe('task filter page', () => {
  beforeEach(() => {
    vi.mocked(fetchTaskFilterCatalog).mockResolvedValue(catalog);
    vi.mocked(fetchTaskChangeCatalog).mockResolvedValue(changeCatalog);
    vi.mocked(getBulkOperationDraft).mockResolvedValue({ draft: null });
    vi.mocked(listSavedTaskFilters).mockResolvedValue([saved]);
    vi.mocked(searchTasks).mockResolvedValue({
      items: [firstTask],
      total: 1,
      page: 1,
      pageSize: 50,
      hasNextPage: false,
    });
    vi.mocked(selectAllTasks).mockResolvedValue({ kind: 'selected', taskIds: ['42'], total: 1 });
    vi.mocked(searchTaskFilterUsers).mockResolvedValue({ items: [], nextCursor: null });
    vi.mocked(createSavedTaskFilter).mockResolvedValue(saved);
    vi.mocked(updateSavedTaskFilter).mockResolvedValue(saved);
    vi.mocked(deleteSavedTaskFilter).mockResolvedValue();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows only catalog operators and applies one-field sorting on the server', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Выбор задач' });

    fireEvent.change(screen.getByRole('combobox', { name: 'Поле нового условия' }), {
      target: { value: 'priority' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));

    const operator = screen.getByRole('combobox', { name: 'Оператор поля Приоритет' });
    expect(
      Array.from(operator.querySelectorAll('option')).map((option) => option.textContent),
    ).toEqual(['включает', 'не включает', 'равно', 'не равно', 'заполнено', 'не заполнено']);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Высокий' }));
    fireEvent.change(screen.getByLabelText('Направление'), { target: { value: 'desc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Применить' }));

    await waitFor(() =>
      expect(searchTasks).toHaveBeenLastCalledWith(
        expect.objectContaining({
          filters: [{ kind: 'list', fieldId: 'priority', operator: 'includes', values: ['high'] }],
          sort: { fieldId: 'deadline', direction: 'desc' },
          page: 1,
        }),
        expect.any(AbortSignal),
      ),
    );
  });

  it('allows the full title operator set when toolbar title search is unused', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Выбор задач' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Поле нового условия' }), {
      target: { value: 'title' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));

    const operator = screen.getByRole('combobox', { name: 'Оператор поля Название' });
    expect(
      Array.from(operator.querySelectorAll('option')).map((option) => option.textContent),
    ).toEqual(['содержит', 'не содержит', 'равно', 'не равно', 'заполнено', 'не заполнено']);
    expect(screen.getByRole('searchbox', { name: 'Поиск по названию' })).toBeDisabled();
  });

  it('loads participant options page by page and keeps selected names visible', async () => {
    vi.mocked(fetchTaskFilterCatalog).mockResolvedValue({
      ...catalog,
      fields: [
        ...catalog.fields,
        {
          id: 'responsible_id',
          label: 'Исполнитель',
          kind: 'user',
          isMultiple: false,
          isNullable: false,
          sortable: true,
          operators: ['equals', 'not_equals', 'includes', 'not_includes', 'is_set', 'is_not_set'],
          valueSource: 'users',
          options: [],
        },
      ],
    });
    vi.mocked(searchTaskFilterUsers).mockImplementation(async (input) =>
      input.cursor === 'next'
        ? { items: [{ id: '11', displayName: 'Ольга' }], nextCursor: null }
        : { items: [{ id: '10', displayName: 'Иван' }], nextCursor: 'next' },
    );
    renderPage();
    await screen.findByRole('heading', { name: 'Выбор задач' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Поле нового условия' }), {
      target: { value: 'responsible_id' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));

    const firstEmployee = await screen.findByRole('checkbox', { name: 'Иван' });
    fireEvent.click(firstEmployee);
    expect(await screen.findByRole('button', { name: 'Удалить Иван' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Показать ещё' }));

    expect(await screen.findByRole('checkbox', { name: 'Ольга' })).toBeInTheDocument();
    expect(searchTaskFilterUsers).toHaveBeenLastCalledWith(
      { q: '', cursor: 'next', pageSize: 20 },
      expect.any(AbortSignal),
    );

    fireEvent.change(screen.getByRole('searchbox', { name: 'Найти сотрудника' }), {
      target: { value: 'И' },
    });
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 350)));
    expect(
      screen.getByText('Введите минимум два символа для уточнения поиска.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Загрузка сотрудников…')).not.toBeInTheDocument();
  });

  it('normalizes number and boolean controls into the canonical search payload', async () => {
    vi.mocked(fetchTaskFilterCatalog).mockResolvedValue({
      ...catalog,
      fields: [
        ...catalog.fields,
        {
          id: 'UF_TASK_EFFORT',
          label: 'Трудозатраты',
          kind: 'number',
          isMultiple: false,
          isNullable: true,
          sortable: true,
          operators: [
            'equals',
            'not_equals',
            'greater_than',
            'less_than',
            'between',
            'is_set',
            'is_not_set',
          ],
          valueSource: 'number',
          options: [],
        },
        {
          id: 'UF_TASK_APPROVED',
          label: 'Согласовано',
          kind: 'boolean',
          isMultiple: false,
          isNullable: false,
          sortable: true,
          operators: ['equals'],
          valueSource: 'boolean',
          options: [],
        },
      ],
    });
    renderPage();
    await screen.findByRole('heading', { name: 'Выбор задач' });
    const fieldSelect = screen.getByRole('combobox', { name: 'Поле нового условия' });
    fireEvent.change(fieldSelect, { target: { value: 'UF_TASK_EFFORT' } });
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));
    fireEvent.change(screen.getByLabelText('Трудозатраты: значение 1'), {
      target: { value: '12.5' },
    });
    fireEvent.change(fieldSelect, { target: { value: 'UF_TASK_APPROVED' } });
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Значение поля Согласовано' }), {
      target: { value: 'false' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Применить' }));

    await waitFor(() =>
      expect(searchTasks).toHaveBeenLastCalledWith(
        expect.objectContaining({
          filters: [
            {
              kind: 'number',
              fieldId: 'UF_TASK_EFFORT',
              operator: 'equals',
              values: [12.5],
            },
            {
              kind: 'boolean',
              fieldId: 'UF_TASK_APPROVED',
              operator: 'equals',
              values: [false],
            },
          ],
        }),
        expect.any(AbortSignal),
      ),
    );
  });

  it('applies a personal filter and can save the current conditions', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Выбор задач' });
    await screen.findByRole('option', { name: 'Срочные' });

    fireEvent.change(screen.getByRole('combobox', { name: 'Личный набор фильтров' }), {
      target: { value: saved.id },
    });
    await waitFor(() =>
      expect(searchTasks).toHaveBeenLastCalledWith(
        expect.objectContaining({ filters: saved.filters }),
        expect.any(AbortSignal),
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Сохранить текущий' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Название' }), {
      target: { value: 'Мой набор' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() =>
      expect(createSavedTaskFilter).toHaveBeenCalledWith({
        name: 'Мой набор',
        filters: saved.filters,
      }),
    );
  });

  it('shows a duplicate-name conflict without treating it as a stale revision', async () => {
    vi.mocked(createSavedTaskFilter).mockRejectedValue(
      new AppApiError('Duplicate', 'internal', 409, 'SAVED_FILTER_NAME_TAKEN', 'TC-duplicate-name'),
    );
    renderPage();
    await screen.findByRole('heading', { name: 'Выбор задач' });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить текущий' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Название' }), {
      target: { value: 'Срочные' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    expect(await screen.findByText('Набор с таким именем уже существует.')).toBeInTheDocument();
    expect(screen.getByText('ID события: TC-duplicate-name')).toBeInTheDocument();
    expect(listSavedTaskFilters).toHaveBeenCalledTimes(1);
  });

  it('keeps a stale personal filter recoverable but blocks its application', async () => {
    const staleSaved: SavedTaskFilter = {
      ...saved,
      name: 'Старый набор',
      filters: [
        { kind: 'list', fieldId: 'priority', operator: 'equals', values: ['removed-option'] },
      ],
    };
    vi.mocked(listSavedTaskFilters).mockResolvedValue([staleSaved]);
    renderPage();
    await screen.findByRole('option', { name: 'Старый набор' });
    await waitFor(() => expect(searchTasks).toHaveBeenCalled());
    vi.mocked(searchTasks).mockClear();

    fireEvent.change(screen.getByRole('combobox', { name: 'Личный набор фильтров' }), {
      target: { value: staleSaved.id },
    });

    expect(
      await screen.findByText('Набор больше не соответствует доступным полям и значениям.'),
    ).toBeInTheDocument();
    expect(searchTasks).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Переименовать' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Удалить' })).toBeEnabled();
  });

  it('uses an explicit ascending fallback sort and marks edited results as stale', async () => {
    vi.mocked(fetchTaskFilterCatalog).mockResolvedValue({
      ...catalog,
      fields: catalog.fields.filter((field) => field.id !== 'deadline'),
    });
    renderPage();
    await screen.findByRole('heading', { name: 'Выбор задач' });

    await waitFor(() =>
      expect(searchTasks).toHaveBeenCalledWith(
        expect.objectContaining({ sort: { fieldId: 'title', direction: 'asc' } }),
        expect.any(AbortSignal),
      ),
    );
    fireEvent.change(screen.getByRole('searchbox', { name: 'Поиск по названию' }), {
      target: { value: 'Новые условия' },
    });

    expect(
      await screen.findByText('Результат устарел: относится к последнему запросу'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Есть неприменённые изменения/)).toBeInTheDocument();
  });

  it('marks a cached zero result as stale after filter edits', async () => {
    vi.mocked(searchTasks).mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 50,
      hasNextPage: false,
    });
    renderPage();
    await screen.findByRole('heading', { name: 'Задачи не найдены' });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Поиск по названию' }), {
      target: { value: 'Изменённый фильтр' },
    });

    expect(
      await screen.findByText('Результат устарел: относится к последнему запросу'),
    ).toBeInTheDocument();
  });

  it('holds the rename dialog while refreshing after a revision conflict', async () => {
    let rejectUpdate: ((error: unknown) => void) | undefined;
    vi.mocked(updateSavedTaskFilter).mockReturnValue(
      new Promise((_, reject) => {
        rejectUpdate = reject;
      }),
    );
    renderPage();
    await screen.findByRole('option', { name: 'Срочные' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Личный набор фильтров' }), {
      target: { value: saved.id },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Переименовать' }));
    const nameInput = screen.getByRole('textbox', { name: 'Название' });
    fireEvent.change(nameInput, { target: { value: 'Конфликт' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    expect(await screen.findByText('Сохраняем набор…')).toBeInTheDocument();
    expect(nameInput).toBeDisabled();
    rejectUpdate?.(new AppApiError('Conflict', 'internal', 409, 'CONFLICT', 'TC-review-conflict'));

    expect(
      await screen.findByText(
        'Набор изменился в другой вкладке. Список обновлён; повторите действие.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('ID события: TC-review-conflict')).toBeInTheDocument();
    expect(listSavedTaskFilters).toHaveBeenCalledTimes(2);
    expect(nameInput).toBeEnabled();
  });

  it('does not claim conflict recovery succeeded when the saved-filter refresh fails', async () => {
    vi.mocked(listSavedTaskFilters)
      .mockResolvedValueOnce([saved])
      .mockRejectedValueOnce(new Error('refresh failed'));
    vi.mocked(updateSavedTaskFilter).mockRejectedValue(
      new AppApiError('Conflict', 'internal', 409, 'CONFLICT', 'TC-refresh-failed'),
    );
    renderPage();
    await screen.findByRole('option', { name: 'Срочные' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Личный набор фильтров' }), {
      target: { value: saved.id },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Переименовать' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Название' }), {
      target: { value: 'Конфликт' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    expect(
      await screen.findByText(
        'Не удалось обновить список наборов. Повторите загрузку перед новым действием.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        'Набор изменился в другой вкладке. Список обновлён; повторите действие.',
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Название' })).toBeEnabled();
  });

  it('closes rename recovery instead of creating when the stale filter was deleted', async () => {
    vi.mocked(listSavedTaskFilters).mockResolvedValueOnce([saved]).mockResolvedValueOnce([]);
    vi.mocked(updateSavedTaskFilter).mockRejectedValue(
      new AppApiError('Conflict', 'internal', 409, 'CONFLICT', 'TC-deleted-filter'),
    );
    renderPage();
    await screen.findByRole('option', { name: 'Срочные' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Личный набор фильтров' }), {
      target: { value: saved.id },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Переименовать' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Название' }), {
      target: { value: 'Удалённый набор' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    expect(
      await screen.findByText('Набор уже удалён в другой вкладке. Список обновлён.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Название' })).not.toBeInTheDocument();
    expect(createSavedTaskFilter).not.toHaveBeenCalled();
  });

  it('renames and deletes only the selected personal filter', async () => {
    const renamed = { ...saved, name: 'Сегодня', revision: 2 };
    vi.mocked(listSavedTaskFilters)
      .mockResolvedValueOnce([saved])
      .mockResolvedValueOnce([renamed])
      .mockResolvedValueOnce([]);
    vi.mocked(updateSavedTaskFilter).mockResolvedValue(renamed);
    renderPage();
    await screen.findByRole('option', { name: 'Срочные' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Личный набор фильтров' }), {
      target: { value: saved.id },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Переименовать' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Название' }), {
      target: { value: 'Сегодня' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() =>
      expect(updateSavedTaskFilter).toHaveBeenCalledWith({ ...saved, name: 'Сегодня' }),
    );
    expect(await screen.findByRole('option', { name: 'Сегодня' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Название' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Удалить' }));
    const deleteButtons = screen.getAllByRole('button', { name: 'Удалить' });
    fireEvent.click(deleteButtons[deleteButtons.length - 1]!);

    await waitFor(() => expect(deleteSavedTaskFilter).toHaveBeenCalledWith(renamed));
    await waitFor(() =>
      expect(screen.queryByRole('option', { name: 'Сегодня' })).not.toBeInTheDocument(),
    );
  });

  it('keeps an authoritative successful rename in cache when its refresh fails', async () => {
    const renamed = { ...saved, name: 'Сегодня', revision: 2 };
    vi.mocked(listSavedTaskFilters)
      .mockResolvedValueOnce([saved])
      .mockRejectedValueOnce(new Error('refresh failed'));
    vi.mocked(updateSavedTaskFilter).mockResolvedValue(renamed);
    renderPage();
    await screen.findByRole('option', { name: 'Срочные' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Личный набор фильтров' }), {
      target: { value: saved.id },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Переименовать' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Название' }), {
      target: { value: 'Сегодня' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    expect(await screen.findByRole('option', { name: 'Сегодня' })).toBeInTheDocument();
    expect(
      await screen.findByText('Изменение сохранено, но список наборов не удалось обновить.'),
    ).toBeInTheDocument();
  });

  it('keeps manual task selection across result pages', async () => {
    vi.mocked(searchTasks).mockImplementation(async (request) => ({
      items: request.page === 1 ? firstPageTasks : [secondTask],
      total: 51,
      page: request.page,
      pageSize: request.pageSize,
      hasNextPage: request.page === 1,
    }));
    renderPage();

    const firstCheckbox = await screen.findByRole('checkbox', {
      name: `Выбрать задачу: ${firstTask.title}`,
    });
    fireEvent.click(firstCheckbox);
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
    fireEvent.click(
      await screen.findByRole('checkbox', { name: `Выбрать задачу: ${secondTask.title}` }),
    );
    expect(screen.getAllByText('Выбрано: 2')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
    expect(
      await screen.findByRole('checkbox', { name: `Выбрать задачу: ${firstTask.title}` }),
    ).toBeChecked();
  });

  it('hands the selected task IDs to the change editor without placing them in navigation', async () => {
    renderPage(appSnapshot);
    fireEvent.click(
      await screen.findByRole('checkbox', { name: `Выбрать задачу: ${firstTask.title}` }),
    );
    const configure = screen.getByRole('button', { name: 'Настроить изменения' });
    await waitFor(() => expect(configure).toBeEnabled());
    fireEvent.click(configure);

    const editorHeading = await screen.findByRole('heading', { name: 'Настройка изменений' });
    await waitFor(() => expect(editorHeading).toHaveFocus());
    expect(screen.getByText('1 задача')).toBeInTheDocument();
    expect(getBulkOperationDraft).toHaveBeenCalledTimes(1);
  });

  it('restores an existing operation draft only after an explicit action', async () => {
    vi.mocked(getBulkOperationDraft).mockResolvedValue({
      draft: {
        id: '123e4567-e89b-42d3-a456-426614174000',
        ownerId: '10',
        revision: 3,
        status: 'preparing',
        filters: [{ kind: 'list', fieldId: 'priority', operator: 'equals', values: ['high'] }],
        sort: { fieldId: 'priority', direction: 'desc' },
        selectedTaskIds: ['42'],
        changes: [{ fieldId: 'title', kind: 'text', action: 'set', value: 'Из черновика' }],
        createdAt: '2026-09-04T10:00:00Z',
        updatedAt: '2026-09-04T10:00:00Z',
        expiresAt: '2026-09-05T10:00:00Z',
      },
    });
    renderPage(appSnapshot);
    fireEvent.click(
      await screen.findByRole('checkbox', { name: `Выбрать задачу: ${firstTask.title}` }),
    );
    const configure = screen.getByRole('button', { name: 'Настроить изменения' });
    await waitFor(() => expect(configure).toBeEnabled());
    fireEvent.click(configure);

    expect(
      await screen.findByRole('heading', { name: 'Найден черновик массовой операции' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Настройка изменений' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Продолжить черновик' }));
    expect(await screen.findByDisplayValue('Из черновика')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Назад к задачам' }));
    await screen.findByRole('heading', { name: 'Выбор задач' });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Настроить изменения' })).toHaveFocus(),
    );
    await waitFor(() => {
      expect(vi.mocked(searchTasks).mock.calls.at(-1)?.[0]).toMatchObject({
        filters: [{ kind: 'list', fieldId: 'priority', operator: 'equals', values: ['high'] }],
        sort: { fieldId: 'priority', direction: 'desc' },
      });
    });
  });

  it('warns before a filter edit clears a selection from another page', async () => {
    vi.mocked(searchTasks).mockImplementation(async (request) => ({
      items: request.page === 1 ? firstPageTasks : [secondTask],
      total: 51,
      page: request.page,
      pageSize: request.pageSize,
      hasNextPage: request.page === 1,
    }));
    renderPage();
    fireEvent.click(
      await screen.findByRole('checkbox', { name: `Выбрать задачу: ${firstTask.title}` }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await screen.findByRole('checkbox', { name: `Выбрать задачу: ${secondTask.title}` });

    const titleSearch = screen.getByRole('searchbox', { name: 'Поиск по названию' });
    fireEvent.change(titleSearch, { target: { value: 'Новый фильтр' } });
    expect(
      await screen.findByRole('heading', { name: 'Изменить фильтр и снять выбор?' }),
    ).toBeInTheDocument();
    expect(titleSearch).toHaveValue('');

    fireEvent.click(screen.getByRole('button', { name: 'Снять выбор и продолжить' }));
    expect(titleSearch).toHaveValue('Новый фильтр');
    expect(screen.queryByText('Выбрано: 1')).not.toBeInTheDocument();
  });

  it('clears a current-page selection immediately when a filter condition changes', async () => {
    renderPage();
    const taskCheckbox = await screen.findByRole('checkbox', {
      name: `Выбрать задачу: ${firstTask.title}`,
    });
    fireEvent.click(taskCheckbox);
    expect(taskCheckbox).toBeChecked();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Поиск по названию' }), {
      target: { value: 'Другой результат' },
    });

    expect(taskCheckbox).not.toBeChecked();
    expect(
      screen.queryByRole('heading', { name: 'Изменить фильтр и снять выбор?' }),
    ).not.toBeInTheDocument();
  });

  it('uses the server result for selecting the whole filtered set', async () => {
    vi.mocked(searchTasks).mockResolvedValue({
      items: [firstTask, secondTask],
      total: 2,
      page: 1,
      pageSize: 50,
      hasNextPage: false,
    });
    vi.mocked(selectAllTasks).mockResolvedValue({
      kind: 'selected',
      taskIds: ['42', '43'],
      total: 2,
    });
    renderPage();
    fireEvent.click(
      await screen.findByRole('checkbox', { name: `Выбрать задачу: ${firstTask.title}` }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Выбрать все' }));

    expect(await screen.findAllByText('Выбрано: 2')).toHaveLength(2);
    expect(
      screen.getByText('Выбран весь результат подтверждённого сервером фильтра.'),
    ).toBeInTheDocument();
    expect(selectAllTasks).toHaveBeenCalledWith(
      {
        filters: [],
        sort: { fieldId: 'deadline', direction: 'asc' },
      },
      expect.any(AbortSignal),
    );
  });

  it('blocks opening the editor while select-all is resolving', async () => {
    const pendingSelection = deferred<Awaited<ReturnType<typeof selectAllTasks>>>();
    vi.mocked(selectAllTasks).mockReturnValue(pendingSelection.promise);
    renderPage(appSnapshot);
    fireEvent.click(
      await screen.findByRole('checkbox', { name: `Выбрать задачу: ${firstTask.title}` }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Выбрать все' }));

    const configure = screen.getByRole('button', { name: 'Настроить изменения' });
    expect(screen.getAllByRole('button', { name: 'Настроить изменения' })).toHaveLength(1);
    expect(configure).toBeDisabled();
    fireEvent.click(configure);
    expect(screen.queryByRole('heading', { name: 'Настройка изменений' })).not.toBeInTheDocument();

    await act(async () => {
      pendingSelection.resolve({ kind: 'selected', taskIds: ['42'], total: 1 });
      await pendingSelection.promise;
    });
    await waitFor(() => expect(configure).toBeEnabled());
  });

  it('ignores a select-all response from a filter generation that was cleared', async () => {
    const pendingSelection = deferred<Awaited<ReturnType<typeof selectAllTasks>>>();
    vi.mocked(selectAllTasks).mockReturnValue(pendingSelection.promise);
    renderPage();
    fireEvent.click(
      await screen.findByRole('checkbox', { name: `Выбрать задачу: ${firstTask.title}` }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Выбрать все' }));
    const selectAllSignal = vi.mocked(selectAllTasks).mock.calls[0]?.[1];
    expect(selectAllSignal).toBeInstanceOf(AbortSignal);

    const titleSearch = screen.getByRole('searchbox', { name: 'Поиск по названию' });
    fireEvent.change(titleSearch, { target: { value: 'Новый фильтр' } });
    expect(titleSearch).toHaveValue('Новый фильтр');
    expect(selectAllSignal?.aborted).toBe(true);
    expect(screen.queryByText('Выбрано: 1')).not.toBeInTheDocument();

    await act(async () => {
      pendingSelection.resolve({ kind: 'selected', taskIds: ['42'], total: 1 });
      await pendingSelection.promise;
    });
    await waitFor(() => expect(screen.queryByText('Выбрано: 1')).not.toBeInTheDocument());
    expect(searchTasks).toHaveBeenCalledTimes(1);
  });

  it(
    'downgrades a previous whole-result selection when the server reports too many tasks',
    async () => {
      vi.mocked(selectAllTasks)
        .mockResolvedValueOnce({ kind: 'selected', taskIds: ['42'], total: 1 })
        .mockResolvedValueOnce({ kind: 'too_many', total: 1001 });
      renderPage();
      fireEvent.click(
        await screen.findByRole('checkbox', { name: `Выбрать задачу: ${firstTask.title}` }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Выбрать все' }));
      expect(
        await screen.findByText('Выбран весь результат подтверждённого сервером фильтра.'),
      ).toBeInTheDocument();

      const selectAllButton = screen.getByRole('button', { name: 'Выбрать все' });
      await waitFor(() => expect(selectAllButton).toBeEnabled());
      fireEvent.click(selectAllButton);
      expect(await screen.findByText(/Найдено 1 001 задач/)).toBeInTheDocument();
      expect(
        screen.queryByText('Выбран весь результат подтверждённого сервером фильтра.'),
      ).not.toBeInTheDocument();
      expect(screen.getAllByText('Выбрано: 1')).toHaveLength(2);
    },
  );

  it('clears empty-result selection metadata when the filter changes', async () => {
    vi.mocked(selectAllTasks).mockResolvedValue({ kind: 'empty', total: 0 });
    renderPage();
    fireEvent.click(
      await screen.findByRole('checkbox', { name: `Выбрать задачу: ${firstTask.title}` }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Выбрать все' }));
    expect(
      await screen.findByText('Результат изменился: доступных задач больше нет.'),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Поиск по названию' }), {
      target: { value: 'Другой фильтр' },
    });
    expect(
      screen.queryByText('Результат изменился: доступных задач больше нет.'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Выбрано: 0/)).not.toBeInTheDocument();
  });

  it('withdraws whole-result provenance when the refreshed page composition changes', async () => {
    vi.mocked(searchTasks)
      .mockResolvedValueOnce({
        items: [firstTask],
        total: 1,
        page: 1,
        pageSize: 50,
        hasNextPage: false,
      })
      .mockResolvedValue({
        items: [secondTask],
        total: 1,
        page: 1,
        pageSize: 50,
        hasNextPage: false,
      });
    renderPage();
    fireEvent.click(
      await screen.findByRole('checkbox', { name: `Выбрать задачу: ${firstTask.title}` }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Выбрать все' }));

    expect(
      await screen.findByText(
        'Результат снова изменился после выбора. Повторите выбор всего результата.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Выбран весь результат подтверждённого сервером фильтра.'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: `Выбрать задачу: ${secondTask.title}` }),
    ).not.toBeChecked();
  });

  it('withdraws whole-result provenance after a later page returns a different task', async () => {
    const replacementTask = {
      ...secondTask,
      id: '44',
      title: 'Новая задача в результате',
      taskUrl: 'https://portal.bitrix24.ru/company/personal/user/10/tasks/task/view/44/',
      relevantVersion: 'version-44',
    };
    vi.mocked(searchTasks).mockImplementation(async (request) => ({
      items: request.page === 1 ? firstPageTasks : [replacementTask],
      total: 51,
      page: request.page,
      pageSize: request.pageSize,
      hasNextPage: request.page === 1,
    }));
    vi.mocked(selectAllTasks).mockResolvedValue({
      kind: 'selected',
      taskIds: [...firstPageTasks.map((task) => task.id), secondTask.id],
      total: 51,
    });
    renderPage();
    fireEvent.click(
      await screen.findByRole('checkbox', { name: `Выбрать задачу: ${firstTask.title}` }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Выбрать все' }));
    expect(
      await screen.findByText('Выбран весь результат подтверждённого сервером фильтра.'),
    ).toBeInTheDocument();
    const nextButton = screen.getByRole('button', { name: 'Далее' });
    await waitFor(() => expect(nextButton).toHaveAttribute('aria-disabled', 'false'));
    fireEvent.click(nextButton);

    expect(
      await screen.findByRole('checkbox', { name: `Выбрать задачу: ${replacementTask.title}` }),
    ).not.toBeChecked();
    expect(
      await screen.findByText(
        'Результат изменился после выбора. Повторите выбор всего результата.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Выбран весь результат подтверждённого сервером фильтра.'),
    ).not.toBeInTheDocument();
  });

  it('keeps pagination focus while the next page replaces placeholder rows', async () => {
    const nextPage = deferred<Awaited<ReturnType<typeof searchTasks>>>();
    vi.mocked(searchTasks).mockImplementation((request) =>
      request.page === 1
        ? Promise.resolve({
            items: firstPageTasks,
            total: 51,
            page: 1,
            pageSize: request.pageSize,
            hasNextPage: true,
          })
        : nextPage.promise,
    );
    renderPage();
    const nextButton = await screen.findByRole('button', { name: 'Далее' });
    nextButton.focus();
    fireEvent.click(nextButton);

    expect(document.activeElement).toBe(nextButton);
    expect(screen.getByRole('region', { name: 'Результаты поиска задач' })).toHaveAttribute(
      'aria-busy',
      'true',
    );

    await act(async () => {
      nextPage.resolve({
        items: [secondTask],
        total: 51,
        page: 2,
        pageSize: 50,
        hasNextPage: false,
      });
      await nextPage.promise;
    });
    await screen.findByRole('checkbox', { name: `Выбрать задачу: ${secondTask.title}` });
    expect(document.activeElement).toBe(nextButton);
  });

  it('corrects a disappeared page once while the replacement page is pending', async () => {
    const correctedPage = deferred<Awaited<ReturnType<typeof searchTasks>>>();
    let secondPageRequests = 0;
    vi.mocked(searchTasks).mockImplementation((request) => {
      if (request.pageSize === 50) {
        return Promise.resolve({
          items: firstPageTasks,
          total: 75,
          page: 1,
          pageSize: 50,
          hasNextPage: true,
        });
      }
      if (request.page === 1) {
        return Promise.resolve({
          items: firstPageTasks.slice(0, 25),
          total: 75,
          page: 1,
          pageSize: 25,
          hasNextPage: true,
        });
      }
      if (request.page === 2) {
        secondPageRequests += 1;
        if (secondPageRequests > 1) return correctedPage.promise;
        return Promise.resolve({
          items: firstPageTasks.slice(25),
          total: 75,
          page: 2,
          pageSize: 25,
          hasNextPage: true,
        });
      }
      return Promise.resolve({
        items: [],
        total: 50,
        page: 3,
        pageSize: 25,
        hasNextPage: false,
      });
    });
    renderPage();
    await screen.findByRole('checkbox', { name: `Выбрать задачу: ${firstTask.title}` });
    fireEvent.change(screen.getByRole('combobox', { name: 'На странице' }), {
      target: { value: '25' },
    });
    await waitFor(() =>
      expect(searchTasks).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 1, pageSize: 25 }),
        expect.any(AbortSignal),
      ),
    );
    const nextButton = screen.getByRole('button', { name: 'Далее' });
    fireEvent.click(nextButton);
    await screen.findByRole('checkbox', { name: 'Выбрать задачу: Задача первой страницы 27' });
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }));

    await waitFor(() => expect(secondPageRequests).toBe(2));
    expect(screen.getByRole('region', { name: 'Результаты поиска задач' })).toHaveAttribute(
      'aria-busy',
      'true',
    );

    await act(async () => {
      correctedPage.resolve({
        items: firstPageTasks.slice(25),
        total: 50,
        page: 2,
        pageSize: 25,
        hasNextPage: false,
      });
      await correctedPage.promise;
    });
    expect(await screen.findByText('Страница 2 из 2')).toBeInTheDocument();
    expect(secondPageRequests).toBe(2);
  });

  it('returns focus to the filter builder after deleting the trigger condition', async () => {
    vi.mocked(searchTasks).mockImplementation(async (request) => ({
      items: request.page === 1 ? firstPageTasks : [secondTask],
      total: 51,
      page: request.page,
      pageSize: request.pageSize,
      hasNextPage: request.page === 1,
    }));
    renderPage();
    await screen.findByRole('checkbox', { name: `Выбрать задачу: ${firstTask.title}` });
    fireEvent.change(screen.getByRole('combobox', { name: 'Поле нового условия' }), {
      target: { value: 'priority' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Высокий' }));
    fireEvent.click(screen.getByRole('button', { name: 'Применить' }));
    await waitFor(() => expect(searchTasks).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('checkbox', { name: `Выбрать задачу: ${firstTask.title}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await screen.findByRole('checkbox', { name: `Выбрать задачу: ${secondTask.title}` });

    const deleteCondition = screen.getByRole('button', { name: 'Удалить условие' });
    deleteCondition.focus();
    fireEvent.click(deleteCondition);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Снять выбор и продолжить' }),
    );

    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('heading', { name: 'Условия фильтра' }),
      ),
    );
    expect(screen.queryByRole('button', { name: 'Удалить условие' })).not.toBeInTheDocument();
  });

  it('preserves manual selection across page-size and sorting changes', async () => {
    renderPage();
    const taskCheckbox = await screen.findByRole('checkbox', {
      name: `Выбрать задачу: ${firstTask.title}`,
    });
    fireEvent.click(taskCheckbox);

    fireEvent.change(screen.getByRole('combobox', { name: 'На странице' }), {
      target: { value: '25' },
    });
    await waitFor(() =>
      expect(searchTasks).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 1, pageSize: 25 }),
        expect.any(AbortSignal),
      ),
    );
    expect(
      screen.getByRole('checkbox', { name: `Выбрать задачу: ${firstTask.title}` }),
    ).toBeChecked();

    fireEvent.change(screen.getByLabelText('Направление'), { target: { value: 'desc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Применить' }));
    await waitFor(() =>
      expect(searchTasks).toHaveBeenLastCalledWith(
        expect.objectContaining({
          page: 1,
          pageSize: 25,
          sort: { fieldId: 'deadline', direction: 'desc' },
        }),
        expect.any(AbortSignal),
      ),
    );
    expect(
      screen.getByRole('checkbox', { name: `Выбрать задачу: ${firstTask.title}` }),
    ).toBeChecked();
  });

  it('blocks selecting the whole result when the server count exceeds 1,000', async () => {
    vi.mocked(searchTasks).mockResolvedValue({
      items: firstPageTasks,
      total: 1001,
      page: 1,
      pageSize: 50,
      hasNextPage: true,
    });
    renderPage();

    expect(
      await screen.findByText(/Выбор всего результата недоступен: найдено 1 001 задач/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Выбрать все' })).toBeDisabled();
    expect(selectAllTasks).not.toHaveBeenCalled();
  });

  it('disables the title shortcut when the dynamic catalog does not expose it', async () => {
    vi.mocked(fetchTaskFilterCatalog).mockResolvedValue({
      ...catalog,
      fields: catalog.fields.filter((field) => field.id !== 'title'),
    });
    renderPage();

    expect(
      await screen.findByRole('searchbox', { name: 'Поиск по названию' }),
    ).toBeDisabled();
  });

  it('blocks search when the adapter exposes no sortable fields', async () => {
    vi.mocked(fetchTaskFilterCatalog).mockResolvedValue({
      ...catalog,
      fields: catalog.fields.map((field) => ({ ...field, sortable: false })),
    });
    renderPage();

    expect(await screen.findByText('Поиск задач недоступен')).toBeInTheDocument();
    expect(searchTasks).not.toHaveBeenCalled();
  });
});
