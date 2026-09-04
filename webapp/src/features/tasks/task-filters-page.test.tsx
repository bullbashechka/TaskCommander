import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SavedTaskFilter, TaskFilterCatalogResponse } from '@task-commander/contracts';

import {
  AppApiError,
  createSavedTaskFilter,
  deleteSavedTaskFilter,
  fetchTaskFilterCatalog,
  listSavedTaskFilters,
  searchTaskFilterUsers,
  searchTasks,
  updateSavedTaskFilter,
} from '@/app/app-api';

import { TaskFiltersPage } from './task-filters-page';

vi.mock('@/app/app-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/app-api')>()),
  createSavedTaskFilter: vi.fn(),
  deleteSavedTaskFilter: vi.fn(),
  fetchTaskFilterCatalog: vi.fn(),
  listSavedTaskFilters: vi.fn(),
  searchTaskFilterUsers: vi.fn(),
  searchTasks: vi.fn(),
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

const saved: SavedTaskFilter = {
  id: 'da94a81c-9d88-4ce4-97d4-d94cbe225d42',
  name: 'Срочные',
  revision: 1,
  filters: [{ kind: 'list', fieldId: 'priority', operator: 'equals', values: ['high'] }],
  createdAt: '2026-09-04T10:00:00Z',
  updatedAt: '2026-09-04T10:00:00Z',
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TaskFiltersPage />
    </QueryClientProvider>,
  );
}

describe('task filter page', () => {
  beforeEach(() => {
    vi.mocked(fetchTaskFilterCatalog).mockResolvedValue(catalog);
    vi.mocked(listSavedTaskFilters).mockResolvedValue([saved]);
    vi.mocked(searchTasks).mockResolvedValue({
      items: [],
      total: 7,
      page: 1,
      pageSize: 50,
      hasNextPage: false,
    });
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
