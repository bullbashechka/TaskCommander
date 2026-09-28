import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';

import type {
  BulkOperationDraft,
  SavedTaskFilter,
  TaskFilterField,
  TaskFilterList,
  TaskSearchApiRequest,
  TaskSelectAllApiRequest,
} from '@task-commander/contracts';

import {
  AppApiError,
  createSavedTaskFilter,
  deleteSavedTaskFilter,
  fetchTaskFilterCatalog,
  getBulkOperationDraft,
  listSavedTaskFilters,
  selectAllTasks,
  searchTaskFilterUsers,
  searchTasks,
  updateSavedTaskFilter,
} from '@/app/app-api';
import { bulkChangeAccessFingerprint, canStartBulkChange } from '@/app/access-policy';
import { useAppAccess } from '@/app/app-context';
import { AppState } from '@/components/ui/app-state';
import { Card } from '@/components/ui/card';
import { Modal } from '@/components/ui/modal';

import {
  areTaskFiltersCompatibleWithCatalog,
  changeDraftOperator,
  createTaskFilterDraft,
  draftsFromFilters,
  operatorLabels,
  operatorValueCount,
  parseTaskFilterDrafts,
  type TaskFilterDraft,
} from './task-filter-model';
import { TaskResultsTable } from './task-results-table';
import { BulkChangeEditor } from './bulk-change-editor';

type ErrorDetails = { message: string; eventId?: string };
type PendingSelectionReset = { apply: () => void };
type SelectAllMutationInput = {
  generation: number;
  request: TaskSelectAllApiRequest;
  signal: AbortSignal;
};
type EditorSession = {
  selectedTaskIds: string[];
  filters: TaskFilterList;
  sort: TaskSearchApiRequest['sort'];
  initialDraft: BulkOperationDraft | null;
  initialRevision: number;
  replaceExpired: boolean;
};

function errorDetails(error: unknown): ErrorDetails {
  if (error instanceof AppApiError) {
    if (error.kind === 'offline') return { message: 'Нет соединения с сетью.' };
    if (error.kind === 'rate_limited')
      return { message: 'Слишком много запросов. Повторите позже.', eventId: error.eventId };
    if (error.code === 'SAVED_FILTER_LIMIT') {
      return { message: 'Достигнут лимит: 256 личных наборов.', eventId: error.eventId };
    }
    if (error.code === 'SAVED_FILTER_NAME_TAKEN') {
      return { message: 'Набор с таким именем уже существует.', eventId: error.eventId };
    }
    if (error.status === 409) {
      return {
        message: 'Набор изменился в другой вкладке. Обновите список.',
        eventId: error.eventId,
      };
    }
    return { message: 'Не удалось получить данные.', eventId: error.eventId };
  }
  return { message: 'Не удалось выполнить действие.' };
}

function InlineError({ details, onRetry }: { details: ErrorDetails; onRetry?: () => void }) {
  return (
    <div className="task-inline-error" role="alert">
      <span>{details.message}</span>
      {details.eventId ? <small>ID события: {details.eventId}</small> : null}
      {onRetry ? (
        <button className="button-link" onClick={onRetry} type="button">
          Повторить
        </button>
      ) : null}
    </div>
  );
}

function UserValueInput({
  values,
  onChange,
}: {
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [selectedLabels, setSelectedLabels] = useState<Record<string, string>>({});
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => window.clearTimeout(timeout);
  }, [query]);
  const users = useInfiniteQuery({
    queryKey: ['task-filter-users', debouncedQuery],
    queryFn: ({ signal, pageParam }) =>
      searchTaskFilterUsers({ q: debouncedQuery, cursor: pageParam, pageSize: 20 }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: debouncedQuery === '' || debouncedQuery.length >= 2,
    staleTime: 30_000,
  });
  const userItems = useMemo(() => {
    const items = users.data?.pages.flatMap((page) => page.items) ?? [];
    return [...new Map(items.map((user) => [user.id, user])).values()];
  }, [users.data]);
  useEffect(() => {
    if (userItems.length === 0) return;
    setSelectedLabels((current) => ({
      ...current,
      ...Object.fromEntries(userItems.map((user) => [user.id, user.displayName])),
    }));
  }, [userItems]);
  return (
    <div className="task-user-picker">
      <input
        aria-label="Найти сотрудника"
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Имя сотрудника"
        type="search"
        value={query}
      />
      {values.length > 0 ? (
        <div aria-label="Выбранные сотрудники" className="task-value-chips">
          {values.map((value) => (
            <button
              aria-label={`Удалить ${selectedLabels[value] ?? value}`}
              key={value}
              onClick={() => onChange(values.filter((item) => item !== value))}
              type="button"
            >
              {selectedLabels[value] ?? `ID ${value}`} ×
            </button>
          ))}
        </div>
      ) : null}
      {query.trim().length === 1 ? (
        <small>Введите минимум два символа для уточнения поиска.</small>
      ) : null}
      {users.isFetching && !users.isFetchingNextPage ? (
        <small role="status">Загрузка сотрудников…</small>
      ) : null}
      {users.isError ? (
        <InlineError details={errorDetails(users.error)} onRetry={() => void users.refetch()} />
      ) : null}
      {users.data ? (
        <fieldset className="task-user-results">
          <legend className="sr-only">Результаты поиска сотрудников</legend>
          {userItems.map((user) => (
            <label key={user.id}>
              <input
                checked={values.includes(user.id)}
                disabled={!values.includes(user.id) && values.length >= 50}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...values, user.id]
                      : values.filter((item) => item !== user.id),
                  )
                }
                type="checkbox"
              />
              <span>{user.displayName}</span>
            </label>
          ))}
          {userItems.length === 0 ? <small>Сотрудники не найдены.</small> : null}
          {values.length >= 50 ? <small>Достигнут лимит: 50 значений.</small> : null}
          {users.hasNextPage ? (
            <button
              className="button-link"
              disabled={users.isFetchingNextPage}
              onClick={() => void users.fetchNextPage()}
              type="button"
            >
              {users.isFetchingNextPage ? 'Загрузка…' : 'Показать ещё'}
            </button>
          ) : null}
        </fieldset>
      ) : null}
    </div>
  );
}

function ValueEditor({
  field,
  draft,
  onChange,
}: {
  field: TaskFilterField;
  draft: TaskFilterDraft;
  onChange: (values: string[]) => void;
}) {
  const count = operatorValueCount(draft.operator);
  if (count === 0) return <span className="task-presence-note">Значение не требуется</span>;
  if (field.kind === 'boolean') {
    return (
      <select
        aria-label={`Значение поля ${field.label}`}
        onChange={(event) => onChange([event.target.value])}
        value={draft.values[0] ?? 'true'}
      >
        <option value="true">Да</option>
        <option value="false">Нет</option>
      </select>
    );
  }
  if (field.valueSource === 'users') {
    return <UserValueInput onChange={onChange} values={draft.values.filter(Boolean)} />;
  }
  if (field.valueSource === 'options') {
    return (
      <fieldset className="task-option-list">
        <legend className="sr-only">Значения поля {field.label}</legend>
        {field.options.map((option) => (
          <label key={option.value}>
            <input
              checked={draft.values.includes(option.value)}
              disabled={
                !draft.values.includes(option.value) && draft.values.filter(Boolean).length >= 50
              }
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...draft.values.filter(Boolean), option.value]
                    : draft.values.filter((value) => value !== option.value),
                )
              }
              type="checkbox"
            />
            <span>{option.label}</span>
          </label>
        ))}
        {draft.values.filter(Boolean).length >= 50 ? (
          <small>Достигнут лимит: 50 значений.</small>
        ) : null}
      </fieldset>
    );
  }

  const inputType =
    field.kind === 'date_time' ? 'datetime-local' : field.kind === 'number' ? 'number' : 'text';
  return (
    <div className="task-values">
      {draft.values.map((value, index) => (
        <div className="task-value-row" key={`${draft.key}-${index}`}>
          <label>
            <span>
              {count === 2 ? (index === 0 ? 'Начало' : 'Конец') : `Значение ${index + 1}`}
            </span>
            <input
              aria-label={`${field.label}: ${
                count === 2 ? (index === 0 ? 'начало' : 'конец') : `значение ${index + 1}`
              }`}
              onChange={(event) =>
                onChange(
                  draft.values.map((item, itemIndex) =>
                    itemIndex === index ? event.target.value : item,
                  ),
                )
              }
              step={
                field.kind === 'number' ? 'any' : field.kind === 'date_time' ? '0.001' : undefined
              }
              type={inputType}
              value={value}
            />
          </label>
          {count === null && draft.values.length > 1 ? (
            <button
              aria-label={`Удалить значение ${index + 1}`}
              className="button-link"
              onClick={() => onChange(draft.values.filter((_, itemIndex) => itemIndex !== index))}
              type="button"
            >
              Удалить
            </button>
          ) : null}
        </div>
      ))}
      {count === null && draft.values.length < 50 ? (
        <button
          className="button-link"
          onClick={() => onChange([...draft.values, ''])}
          type="button"
        >
          {field.isMultiple && (draft.operator === 'equals' || draft.operator === 'not_equals')
            ? '+ Значение набора'
            : '+ Значение ИЛИ'}
        </button>
      ) : null}
    </div>
  );
}

function SavedFilterDialog({
  mode,
  initialName,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  mode: 'create' | 'rename' | null;
  initialName: string;
  pending: boolean;
  error: ErrorDetails | null;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(initialName);
  return (
    <Modal
      description={
        mode === 'create'
          ? 'Сохраняются условия фильтра. Текущая сортировка в набор не входит.'
          : 'Новое имя применяется только к вашему личному набору.'
      }
      onClose={onClose}
      open={mode !== null}
      title={mode === 'create' ? 'Сохранить набор фильтров' : 'Переименовать набор'}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(name);
        }}
      >
        <label className="dialog-field">
          Название
          <input
            autoComplete="off"
            disabled={pending}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            required
            value={name}
          />
        </label>
        {error ? <InlineError details={error} /> : null}
        {pending ? <p role="status">Сохраняем набор…</p> : null}
        <div className="dialog-actions">
          <button className="button-secondary" disabled={pending} onClick={onClose} type="button">
            Отмена
          </button>
          <button className="button-primary" disabled={pending || !name.trim()} type="submit">
            {pending ? 'Сохранение…' : 'Сохранить'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function TaskFiltersPage() {
  const navigate = useNavigate();
  const app = useAppAccess();
  const queryClient = useQueryClient();
  const catalog = useQuery({
    queryKey: ['task-filter-catalog'],
    queryFn: ({ signal }) => fetchTaskFilterCatalog(signal),
    staleTime: 300_000,
  });
  const savedFilters = useQuery({
    queryKey: ['saved-task-filters'],
    queryFn: ({ signal }) => listSavedTaskFilters(signal),
  });
  const [titleSearch, setTitleSearch] = useState('');
  const [drafts, setDrafts] = useState<TaskFilterDraft[]>([]);
  const [selectedFieldId, setSelectedFieldId] = useState('');
  const [selectedSavedId, setSelectedSavedId] = useState('');
  const [sort, setSort] = useState<TaskSearchApiRequest['sort']>({
    fieldId: 'deadline',
    direction: 'asc',
  });
  const [validationError, setValidationError] = useState('');
  const [savedError, setSavedError] = useState<ErrorDetails | null>(null);
  const [dialogMode, setDialogMode] = useState<'create' | 'rename' | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [appliedRequest, setAppliedRequest] = useState<TaskSearchApiRequest | null>(null);
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(() => new Set());
  const [selectionSource, setSelectionSource] = useState<'manual' | 'all-filtered'>('manual');
  const [selectionTotal, setSelectionTotal] = useState<number | null>(null);
  const [selectionError, setSelectionError] = useState<ErrorDetails | null>(null);
  const [pendingSelectionReset, setPendingSelectionReset] =
    useState<PendingSelectionReset | null>(null);
  const [draftChoiceOpen, setDraftChoiceOpen] = useState(false);
  const [editorSession, setEditorSession] = useState<EditorSession | null>(null);
  const selectionGeneration = useRef(0);
  const selectionAbortController = useRef<AbortController | null>(null);
  const filterBuilderHeadingRef = useRef<HTMLHeadingElement>(null);
  const configureButtonRef = useRef<HTMLButtonElement>(null);
  const sortableFields = useMemo(
    () => catalog.data?.fields.filter((field) => field.sortable) ?? [],
    [catalog.data],
  );
  const defaultSort = useMemo<TaskSearchApiRequest['sort'] | null>(() => {
    if (!catalog.data) return null;
    return {
      fieldId:
        sortableFields.find((field) => field.id === 'deadline')?.id ?? sortableFields[0]?.id ?? '',
      direction: 'asc',
    };
  }, [catalog.data, sortableFields]);
  const accessFingerprint = app ? bulkChangeAccessFingerprint(app) : 'isolated';
  const currentOperationDraft = useQuery({
    queryKey: ['bulk-operation-draft', app?.generation ?? 0, accessFingerprint],
    queryFn: ({ signal }) => getBulkOperationDraft(signal),
    enabled: app ? canStartBulkChange(app) : false,
    staleTime: 30_000,
  });
  useEffect(() => {
    if (!defaultSort?.fieldId) return;
    if (!sortableFields.some((field) => field.id === sort.fieldId)) setSort(defaultSort);
  }, [defaultSort, sort.fieldId, sortableFields]);
  const effectiveAppliedRequest =
    appliedRequest ??
    (defaultSort?.fieldId ? { filters: [], sort: defaultSort, page: 1, pageSize: 50 } : null);

  const search = useQuery({
    queryKey: ['task-search', effectiveAppliedRequest],
    queryFn: ({ signal }) =>
      effectiveAppliedRequest
        ? searchTasks(effectiveAppliedRequest, signal)
        : Promise.reject(new Error('No sortable task fields.')),
    enabled: catalog.isSuccess && effectiveAppliedRequest !== null,
    placeholderData: keepPreviousData,
  });
  const selectAllMutation = useMutation({
    mutationFn: ({ request, signal }: SelectAllMutationInput) => selectAllTasks(request, signal),
    onSuccess: async (result, input) => {
      if (input.generation !== selectionGeneration.current) return;
      if (result.kind === 'selected') {
        setSelectedTaskIds(new Set(result.taskIds));
        setSelectionSource('all-filtered');
        setSelectionTotal(result.total);
        setSelectionError(null);
      } else if (result.kind === 'too_many') {
        setSelectionSource('manual');
        setSelectionTotal(null);
        setSelectionError({
          message:
            `Найдено ${result.total.toLocaleString('ru-RU')} задач. ` +
            'Сузьте фильтр до 1 000 задач.',
        });
      } else {
        setSelectedTaskIds(new Set());
        setSelectionSource('manual');
        setSelectionTotal(null);
        setSelectionError({ message: 'Результат изменился: доступных задач больше нет.' });
      }
      const refreshed = await search.refetch();
      if (input.generation !== selectionGeneration.current) return;
      if (refreshed.isError && result.kind === 'selected') {
        setSelectionError({
          message: 'Задачи выбраны, но текущую страницу не удалось обновить.',
        });
      } else if (
        result.kind === 'selected' &&
        refreshed.data &&
        (refreshed.data.total !== result.total ||
          refreshed.data.items.some((task) => !result.taskIds.includes(task.id)))
      ) {
        setSelectionSource('manual');
        setSelectionTotal(null);
        setSelectionError({
          message: 'Результат снова изменился после выбора. Повторите выбор всего результата.',
        });
      }
    },
    onError: (error, input) => {
      if (input.generation === selectionGeneration.current) {
        setSelectionError(errorDetails(error));
      }
    },
    onSettled: (_result, _error, input) => {
      if (input.generation === selectionGeneration.current) {
        selectionAbortController.current = null;
      }
    },
  });
  useEffect(() => {
    if (
      search.isFetching ||
      search.isError ||
      selectionSource !== 'all-filtered' ||
      selectionTotal === null ||
      !search.data
    ) {
      return;
    }
    const resultChanged =
      search.data.total !== selectionTotal ||
      search.data.items.some((task) => !selectedTaskIds.has(task.id));
    if (!resultChanged) return;
    setSelectionSource('manual');
    setSelectionTotal(null);
    setSelectionError({
      message: 'Результат изменился после выбора. Повторите выбор всего результата.',
    });
  }, [
    search.data,
    search.isError,
    search.isFetching,
    selectedTaskIds,
    selectionSource,
    selectionTotal,
  ]);
  useEffect(() => {
    if (!search.data || !effectiveAppliedRequest || search.isPlaceholderData) return;
    const lastPage = Math.max(1, Math.ceil(search.data.total / search.data.pageSize));
    if (effectiveAppliedRequest.page > lastPage) {
      setAppliedRequest({ ...effectiveAppliedRequest, page: lastPage });
    }
  }, [effectiveAppliedRequest, search.data, search.isPlaceholderData]);
  const selectedSaved = savedFilters.data?.find((filter) => filter.id === selectedSavedId);
  const usedFieldIds = new Set([
    ...drafts.map((draft) => draft.fieldId),
    ...(titleSearch.trim() ? ['title'] : []),
  ]);
  const activeCount = drafts.length + (titleSearch.trim() ? 1 : 0);
  const availableFields =
    activeCount >= 256 ? [] : catalog.data?.fields.filter((field) => !usedFieldIds.has(field.id));
  const fieldsById = useMemo(
    () => new Map(catalog.data?.fields.map((field) => [field.id, field]) ?? []),
    [catalog.data],
  );
  const currentParsed = catalog.data
    ? parseTaskFilterDrafts(titleSearch, drafts, catalog.data.fields)
    : null;
  const currentSearchSignature = currentParsed?.success
    ? JSON.stringify({ filters: currentParsed.filters, sort })
    : null;
  const appliedSearchSignature = JSON.stringify({
    filters: effectiveAppliedRequest?.filters ?? [],
    sort: effectiveAppliedRequest?.sort ?? defaultSort,
  });
  const hasPendingChanges =
    currentSearchSignature === null || currentSearchSignature !== appliedSearchSignature;

  const saveMutation = useMutation({
    mutationFn: (
      input:
        | { mode: 'create'; name: string; filters: TaskFilterList }
        | { mode: 'rename'; name: string; saved: SavedTaskFilter },
    ) =>
      input.mode === 'create'
        ? createSavedTaskFilter({ name: input.name, filters: input.filters })
        : updateSavedTaskFilter({ ...input.saved, name: input.name }),
    onSuccess: async (saved) => {
      setSelectedSavedId(saved.id);
      setDialogMode(null);
      setSavedError(null);
      queryClient.setQueryData<SavedTaskFilter[]>(['saved-task-filters'], (current = []) => {
        const existingIndex = current.findIndex((item) => item.id === saved.id);
        if (existingIndex === -1) return [...current, saved];
        return current.map((item) => (item.id === saved.id ? saved : item));
      });
      const refreshed = await savedFilters.refetch();
      if (refreshed.isError) {
        setSavedError({ message: 'Изменение сохранено, но список наборов не удалось обновить.' });
      }
    },
    onError: async (error, variables) => {
      const details = errorDetails(error);
      if (error instanceof AppApiError && error.code === 'CONFLICT') {
        setSavedError({
          ...details,
          message: 'Набор изменился в другой вкладке. Обновляем список…',
        });
        const refreshed = await savedFilters.refetch();
        if (refreshed.isError) {
          setSavedError({
            ...details,
            message:
              'Не удалось обновить список наборов. Повторите загрузку перед новым действием.',
          });
          return;
        }
        if (
          variables.mode === 'rename' &&
          !refreshed.data?.some((saved) => saved.id === variables.saved.id)
        ) {
          setSelectedSavedId('');
          setDialogMode(null);
          setSavedError({
            ...details,
            message: 'Набор уже удалён в другой вкладке. Список обновлён.',
          });
          return;
        }
        setSavedError({
          ...details,
          message: 'Набор изменился в другой вкладке. Список обновлён; повторите действие.',
        });
        return;
      }
      setSavedError(details);
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (saved: SavedTaskFilter) => deleteSavedTaskFilter(saved),
    onSuccess: async (_result, deleted) => {
      setSelectedSavedId('');
      setDeleteOpen(false);
      setSavedError(null);
      queryClient.setQueryData<SavedTaskFilter[]>(['saved-task-filters'], (current = []) =>
        current.filter((saved) => saved.id !== deleted.id),
      );
      const refreshed = await savedFilters.refetch();
      if (refreshed.isError) {
        setSavedError({ message: 'Набор удалён, но список наборов не удалось обновить.' });
      }
    },
    onError: async (error, deleted) => {
      const details = errorDetails(error);
      if (error instanceof AppApiError && error.code === 'CONFLICT') {
        setSavedError({
          ...details,
          message: 'Набор изменился в другой вкладке. Обновляем список…',
        });
        const refreshed = await savedFilters.refetch();
        if (refreshed.isError) {
          setSavedError({
            ...details,
            message:
              'Не удалось обновить список наборов. Повторите загрузку перед новым действием.',
          });
          return;
        }
        if (!refreshed.data?.some((saved) => saved.id === deleted.id)) {
          setSelectedSavedId('');
          setDeleteOpen(false);
          setSavedError({
            ...details,
            message: 'Набор уже удалён в другой вкладке. Список обновлён.',
          });
          return;
        }
        setSavedError({
          ...details,
          message: 'Набор изменился в другой вкладке. Список обновлён; повторите действие.',
        });
        return;
      }
      setSavedError(details);
    },
  });

  if (editorSession) {
    return (
      <div className="page-content">
        <BulkChangeEditor
          onOperationLaunched={(operation) => {
            void navigate({ to: '/operations/$operationId', params: { operationId: operation.id } });
          }}
          filters={editorSession.filters}
          initialDraft={editorSession.initialDraft}
          initialRevision={editorSession.initialRevision}
          onBack={() => {
            setEditorSession(null);
            window.setTimeout(() => configureButtonRef.current?.focus(), 0);
          }}
          onSaved={(draft) => {
            queryClient.setQueryData(
              ['bulk-operation-draft', app?.generation ?? 0, accessFingerprint],
              { draft },
            );
          }}
          selectedTaskIds={editorSession.selectedTaskIds}
          sort={editorSession.sort}
          replaceExpired={editorSession.replaceExpired}
        />
      </div>
    );
  }

  if (catalog.isPending) {
    return (
      <div className="page-content">
        <AppState
          compact
          description="Загружаем доступные поля и операторы."
          title="Подготовка фильтров"
        />
      </div>
    );
  }
  if (catalog.isError) {
    const details = errorDetails(catalog.error);
    return (
      <div className="page-content">
        <AppState
          action={
            <button className="button-primary" onClick={() => void catalog.refetch()} type="button">
              Повторить
            </button>
          }
          compact
          description={details.message}
          eventId={details.eventId}
          title="Фильтры недоступны"
        />
      </div>
    );
  }
  if (sortableFields.length === 0) {
    return (
      <div className="page-content">
        <AppState
          compact
          description="Bitrix24 не подтвердил ни одного поля для безопасной сортировки."
          title="Поиск задач недоступен"
        />
      </div>
    );
  }

  function clearSelectionState() {
    selectionGeneration.current += 1;
    selectionAbortController.current?.abort();
    selectionAbortController.current = null;
    selectAllMutation.reset();
    setSelectedTaskIds(new Set());
    setSelectionSource('manual');
    setSelectionTotal(null);
    setSelectionError(null);
  }

  function openEditor(initialDraft: BulkOperationDraft | null) {
    if (!effectiveAppliedRequest) return;
    if (
      initialDraft &&
      (!areTaskFiltersCompatibleWithCatalog(initialDraft.filters, catalog.data.fields) ||
        !sortableFields.some((field) => field.id === initialDraft.sort.fieldId))
    ) {
      setDraftChoiceOpen(false);
      setSelectionError({
        message: 'Черновик использует поля, которые больше недоступны. Начните настройку заново.',
      });
      return;
    }
    const restoredTaskIds = initialDraft?.selectedTaskIds ?? [...selectedTaskIds];
    if (restoredTaskIds.length === 0) return;
    if (initialDraft) {
      const restoredFilters = draftsFromFilters(initialDraft.filters);
      setTitleSearch(restoredFilters.titleSearch);
      setDrafts(restoredFilters.drafts);
      setSort(initialDraft.sort);
      setAppliedRequest({
        filters: initialDraft.filters,
        sort: initialDraft.sort,
        page: 1,
        pageSize: effectiveAppliedRequest.pageSize,
      });
      setSelectedSavedId('');
      setSelectedTaskIds(new Set(initialDraft.selectedTaskIds));
      setSelectionSource('manual');
      setSelectionTotal(null);
    }
    setDraftChoiceOpen(false);
    setEditorSession({
      selectedTaskIds: [...restoredTaskIds],
      filters: initialDraft?.filters ?? effectiveAppliedRequest.filters,
      sort: initialDraft?.sort ?? effectiveAppliedRequest.sort,
      initialDraft,
      initialRevision: initialDraft?.revision ?? currentOperationDraft.data?.draft?.revision ?? 0,
      replaceExpired: initialDraft === null,
    });
  }

  function configureChanges() {
    if (selectAllMutation.isPending) return;
    if (currentOperationDraft.data?.draft) {
      setDraftChoiceOpen(true);
      return;
    }
    openEditor(null);
  }

  function selectAllCurrentResult() {
    if (!effectiveAppliedRequest) return;
    selectionAbortController.current?.abort();
    const controller = new AbortController();
    selectionAbortController.current = controller;
    const generation = selectionGeneration.current + 1;
    selectionGeneration.current = generation;
    setSelectionError(null);
    selectAllMutation.mutate({
      generation,
      signal: controller.signal,
      request: {
        filters: effectiveAppliedRequest.filters,
        sort: effectiveAppliedRequest.sort,
      },
    });
  }

  function changeFilter(apply: () => void) {
    if (selectedTaskIds.size === 0) {
      clearSelectionState();
      apply();
      return;
    }
    const currentPageIds = new Set(search.data?.items.map((task) => task.id) ?? []);
    const includesOffPageSelection = [...selectedTaskIds].some(
      (taskId) => !currentPageIds.has(taskId),
    );
    if (includesOffPageSelection) {
      setPendingSelectionReset({
        apply: () => {
          clearSelectionState();
          apply();
        },
      });
      return;
    }
    clearSelectionState();
    apply();
  }

  function toggleTask(taskId: string, selected: boolean) {
    setSelectionError(null);
    setSelectionSource('manual');
    setSelectionTotal(null);
    setSelectedTaskIds((current) => {
      if (selected && current.size >= 1000) return current;
      const next = new Set(current);
      if (selected) next.add(taskId);
      else next.delete(taskId);
      return next;
    });
  }

  function togglePage(taskIds: string[], selected: boolean) {
    const additionalCount = taskIds.filter((taskId) => !selectedTaskIds.has(taskId)).length;
    if (selected && selectedTaskIds.size + additionalCount > 1000) {
      setSelectionError({ message: 'Нельзя выбрать больше 1 000 задач.' });
      return;
    }
    setSelectionError(null);
    setSelectionSource('manual');
    setSelectionTotal(null);
    setSelectedTaskIds((current) => {
      const next = new Set(current);
      for (const taskId of taskIds) {
        if (selected) next.add(taskId);
        else next.delete(taskId);
      }
      return next;
    });
  }

  function changePage(page: number) {
    if (!effectiveAppliedRequest || page < 1) return;
    setAppliedRequest({ ...effectiveAppliedRequest, page });
  }

  function changePageSize(pageSize: number) {
    if (!effectiveAppliedRequest) return;
    setAppliedRequest({ ...effectiveAppliedRequest, page: 1, pageSize });
  }

  function parseCurrentFilters(): TaskFilterList | null {
    const parsed = currentParsed;
    if (!parsed) return null;
    if (!parsed.success) {
      setValidationError(parsed.message);
      return null;
    }
    setValidationError('');
    return parsed.filters;
  }

  function applyFilters(filters = parseCurrentFilters()) {
    if (!filters) return;
    const next: TaskSearchApiRequest = {
      filters,
      sort,
      page: 1,
      pageSize: effectiveAppliedRequest?.pageSize ?? 50,
    };
    if (JSON.stringify(next) === JSON.stringify(effectiveAppliedRequest)) void search.refetch();
    else setAppliedRequest(next);
  }

  function applySavedFilter(saved: SavedTaskFilter) {
    if (!areTaskFiltersCompatibleWithCatalog(saved.filters, catalog.data.fields)) {
      setSelectedSavedId(saved.id);
      setSavedError({ message: 'Набор больше не соответствует доступным полям и значениям.' });
      return;
    }
    const state = draftsFromFilters(saved.filters);
    const parsed = parseTaskFilterDrafts(state.titleSearch, state.drafts, catalog.data.fields);
    if (!parsed.success) {
      setSelectedSavedId(saved.id);
      setSavedError({ message: 'Набор больше не соответствует доступным полям и значениям.' });
      return;
    }
    changeFilter(() => {
      setSelectedSavedId(saved.id);
      setTitleSearch(state.titleSearch);
      setDrafts(state.drafts);
      setValidationError('');
      setSavedError(null);
      applyFilters(parsed.filters);
    });
  }

  function submitSavedFilter(name: string) {
    if (dialogMode === 'rename') {
      if (!selectedSaved) {
        setSavedError({ message: 'Выбранный набор больше недоступен.' });
        return;
      }
      saveMutation.mutate({ mode: 'rename', name: name.trim(), saved: selectedSaved });
      return;
    }
    if (!currentParsed?.success) {
      setSavedError({
        message: currentParsed?.message ?? 'Не удалось проверить условия фильтра.',
      });
      return;
    }
    saveMutation.mutate({ mode: 'create', name: name.trim(), filters: currentParsed.filters });
  }

  function clearFilters() {
    changeFilter(() => {
      setTitleSearch('');
      setDrafts([]);
      setSelectedSavedId('');
      setValidationError('');
      applyFilters([]);
    });
  }

  return (
    <div className="page-content task-filter-page">
      <nav aria-label="Хлебные крошки" className="breadcrumbs">
        <span>Task Commander</span>
        <i>/</i>
        <strong>Массовое изменение</strong>
      </nav>
      <header className="task-filter-header">
        <div>
          <span className="eyebrow">Этап 1 из 4</span>
          <h1>Выбор задач</h1>
          <p>Условия применяются к незавершённым задачам. Разные поля соединяются через И.</p>
        </div>
      </header>

      <Card className="task-toolbar-card">
        <div className="task-toolbar">
          <label>
            Область
            <select disabled value="unfinished">
              <option value="unfinished">Все незавершённые</option>
            </select>
          </label>
          <label className="task-title-search">
            Поиск по названию
            <input
              disabled={
                !fieldsById.get('title')?.operators.includes('contains') ||
                drafts.some((draft) => draft.fieldId === 'title') ||
                (activeCount >= 256 && !titleSearch.trim())
              }
              onChange={(event) => {
                const value = event.target.value;
                changeFilter(() => setTitleSearch(value));
              }}
              placeholder="Название задачи"
              type="search"
              value={titleSearch}
            />
          </label>
          <button
            className="filter-button"
            onClick={() => document.getElementById('task-filter-builder')?.focus()}
            type="button"
          >
            Фильтры <span>{activeCount}</span>
          </button>
          <button className="button-primary" onClick={() => applyFilters()} type="button">
            Применить
          </button>
        </div>
        {hasPendingChanges ? (
          <p className="task-pending-note" role="status">
            Есть неприменённые изменения. Число найденных задач относится к последнему запросу.
          </p>
        ) : null}
      </Card>

      <div className="task-filter-layout">
        <Card className="task-filter-builder-card">
          <div className="task-card-heading">
            <div>
              <h2 id="task-filter-builder" ref={filterBuilderHeadingRef} tabIndex={-1}>
                Условия фильтра
              </h2>
              <p>
                Значения обычно соединяются через ИЛИ. «Равно» для множественного поля сравнивает
                весь набор, а «Не равно» исключает точное совпадение набора.
              </p>
            </div>
            <div className="task-add-condition">
              <select
                aria-label="Поле нового условия"
                onChange={(event) => setSelectedFieldId(event.target.value)}
                value={selectedFieldId}
              >
                <option value="">Выберите поле</option>
                {availableFields?.map((field) => (
                  <option key={field.id} value={field.id}>
                    {field.label}
                  </option>
                ))}
              </select>
              <button
                className="button-secondary"
                disabled={!selectedFieldId || activeCount >= 256}
                onClick={() => {
                  const field = fieldsById.get(selectedFieldId);
                  if (!field) return;
                  changeFilter(() => {
                    setDrafts((current) => [...current, createTaskFilterDraft(field)]);
                    setSelectedFieldId('');
                  });
                }}
                type="button"
              >
                Добавить
              </button>
            </div>
          </div>

          {activeCount >= 256 ? (
            <p className="task-field-error" role="status">
              Достигнут лимит: 256 условий.
            </p>
          ) : null}

          {drafts.length === 0 && !titleSearch.trim() ? (
            <div className="task-empty-filter">
              Условия не заданы. Будут найдены все незавершённые задачи.
            </div>
          ) : null}
          <div className="task-condition-list">
            {drafts.map((draft) => {
              const field = fieldsById.get(draft.fieldId);
              if (!field) return null;
              return (
                <section
                  aria-labelledby={`task-condition-${draft.key}`}
                  className="task-condition"
                  key={draft.key}
                >
                  <div className="task-condition-controls">
                    <strong id={`task-condition-${draft.key}`}>{field.label}</strong>
                    <select
                      aria-label={`Оператор поля ${field.label}`}
                      onChange={(event) => {
                        const operator = event.target.value as TaskFilterDraft['operator'];
                        changeFilter(() =>
                          setDrafts((current) =>
                            current.map((item) =>
                              item.key === draft.key ? changeDraftOperator(item, operator) : item,
                            ),
                          ),
                        );
                      }}
                      value={draft.operator}
                    >
                      {field.operators.map((operator) => (
                        <option key={operator} value={operator}>
                          {operatorLabels[operator]}
                        </option>
                      ))}
                    </select>
                    <button
                      className="button-link"
                      onClick={() =>
                        changeFilter(() =>
                          setDrafts((current) =>
                            current.filter((item) => item.key !== draft.key),
                          ),
                        )
                      }
                      type="button"
                    >
                      Удалить условие
                    </button>
                  </div>
                  <ValueEditor
                    draft={draft}
                    field={field}
                    onChange={(values) =>
                      changeFilter(() =>
                        setDrafts((current) =>
                          current.map((item) =>
                            item.key === draft.key ? { ...item, values } : item,
                          ),
                        ),
                      )
                    }
                  />
                </section>
              );
            })}
          </div>
          {validationError ? (
            <p className="task-field-error" role="alert">
              {validationError}
            </p>
          ) : null}
        </Card>

        <aside className="task-filter-sidebar">
          <Card>
            <h2>Сортировка</h2>
            <label>
              Поле
              <select
                onChange={(event) =>
                  setSort((current) => ({ ...current, fieldId: event.target.value }))
                }
                value={sort.fieldId}
              >
                {sortableFields.map((field) => (
                  <option key={field.id} value={field.id}>
                    {field.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Направление
              <select
                onChange={(event) =>
                  setSort((current) => ({
                    ...current,
                    direction: event.target.value === 'desc' ? 'desc' : 'asc',
                  }))
                }
                value={sort.direction}
              >
                <option value="asc">По возрастанию</option>
                <option value="desc">По убыванию</option>
              </select>
            </label>
          </Card>
          <Card>
            <h2>Личные наборы</h2>
            {savedFilters.isError ? (
              <InlineError
                details={errorDetails(savedFilters.error)}
                onRetry={() => void savedFilters.refetch()}
              />
            ) : null}
            <select
              aria-label="Личный набор фильтров"
              disabled={savedFilters.isPending}
              onChange={(event) => {
                const saved = savedFilters.data?.find((item) => item.id === event.target.value);
                if (saved) applySavedFilter(saved);
                else setSelectedSavedId('');
              }}
              value={selectedSavedId}
            >
              <option value="">{savedFilters.isPending ? 'Загрузка…' : 'Выберите набор'}</option>
              {savedFilters.data?.map((saved) => (
                <option key={saved.id} value={saved.id}>
                  {saved.name}
                </option>
              ))}
            </select>
            <div className="task-saved-actions">
              <button
                className="button-secondary"
                onClick={() => {
                  setSavedError(null);
                  if (parseCurrentFilters()) setDialogMode('create');
                }}
                type="button"
              >
                Сохранить текущий
              </button>
              <button
                className="button-link"
                disabled={!selectedSaved}
                onClick={() => {
                  setSavedError(null);
                  setDialogMode('rename');
                }}
                type="button"
              >
                Переименовать
              </button>
              <button
                className="button-link task-danger"
                disabled={!selectedSaved}
                onClick={() => {
                  setSavedError(null);
                  setDeleteOpen(true);
                }}
                type="button"
              >
                Удалить
              </button>
            </div>
            {savedError && !dialogMode && !deleteOpen ? <InlineError details={savedError} /> : null}
          </Card>
        </aside>
      </div>

      <Card
        className={`task-search-summary ${hasPendingChanges ? 'task-search-summary-stale' : ''}`}
        aria-live="polite"
      >
        {search.isFetching ? <p>Применяем условия…</p> : null}
        {search.data && hasPendingChanges ? (
          <span className="task-stale-label">
            Результат устарел: относится к последнему запросу
          </span>
        ) : null}
        {search.isError
          ? (() => {
              const details = errorDetails(search.error);
              return (
                <AppState
                  action={
                    <button
                      className="button-secondary"
                      onClick={() => void search.refetch()}
                      type="button"
                    >
                      Повторить
                    </button>
                  }
                  compact
                  description={details.message}
                  eventId={details.eventId}
                  title="Не удалось выполнить поиск"
                />
              );
            })()
          : null}
        {search.data && !search.isFetching && !search.isError && search.data.total > 0 ? (
          <>
            <span>Найдено задач</span>
            <strong>{search.data.total.toLocaleString('ru-RU')}</strong>
            <p>Результат поиска ещё не является подтверждением массовой операции.</p>
          </>
        ) : null}
        {search.data && !search.isFetching && !search.isError && search.data.total === 0 ? (
          <div className="task-zero-state">
            <h2>Задачи не найдены</h2>
            <p>Измените условия или очистите фильтр.</p>
            {(effectiveAppliedRequest?.filters.length ?? 0) > 0 ? (
              <button className="button-secondary" onClick={clearFilters} type="button">
                Очистить фильтр
              </button>
            ) : null}
          </div>
        ) : null}
      </Card>

      {search.isPending ? (
        <Card className="task-table-loading">
          <div aria-busy="true" aria-label="Загрузка таблицы задач">
            <div className="skeleton task-table-skeleton-head" />
            <div className="skeleton task-table-skeleton-body" />
          </div>
        </Card>
      ) : null}

      {search.data && search.data.total > 0 ? (
        <Card
          aria-busy={search.isFetching}
          aria-label="Результаты поиска задач"
          className="task-table-card"
        >
          {selectedTaskIds.size > 0 || search.data.total > 1000 || selectionError ? (
            <section
              aria-live="polite"
              className="task-selection-summary"
              id="task-selection-summary"
              tabIndex={-1}
            >
              <div>
                <strong>Выбрано: {selectedTaskIds.size.toLocaleString('ru-RU')}</strong>
                <span>
                  из {(selectionTotal ?? search.data.total).toLocaleString('ru-RU')} задач
                </span>
                {selectionSource === 'all-filtered' ? (
                  <small>Выбран весь результат подтверждённого сервером фильтра.</small>
                ) : null}
              </div>
              <div className="task-selection-actions">
                <button
                  className="button-link"
                  disabled={
                    hasPendingChanges ||
                    search.isFetching ||
                    selectAllMutation.isPending ||
                    search.data.total === 0 ||
                    search.data.total > 1000
                  }
                  onClick={selectAllCurrentResult}
                  type="button"
                >
                  {selectAllMutation.isPending ? 'Проверяем выбор…' : 'Выбрать все'}
                </button>
                <button
                  className="button-link"
                  disabled={selectedTaskIds.size === 0 || selectAllMutation.isPending}
                  onClick={clearSelectionState}
                  type="button"
                >
                  Снять выбор
                </button>
              </div>
              {search.data.total > 1000 ? (
                <p className="task-selection-limit" role="status">
                  Выбор всего результата недоступен: найдено{' '}
                  {search.data.total.toLocaleString('ru-RU')} задач. Сузьте фильтр до 1 000 задач.
                </p>
              ) : null}
              {selectedTaskIds.size >= 1000 ? (
                <p className="task-selection-limit" role="status">
                  Достигнут предел одной операции: 1 000 задач.
                </p>
              ) : null}
              {selectionError ? (
                <InlineError
                  details={selectionError}
                  onRetry={
                    search.data.total <= 1000 ? selectAllCurrentResult : undefined
                  }
                />
              ) : null}
            </section>
          ) : null}

          <TaskResultsTable
            items={search.data.items}
            onTogglePage={togglePage}
            onToggleTask={toggleTask}
            selectedIds={selectedTaskIds}
            selectionDisabled={
              hasPendingChanges ||
              search.isError ||
              search.isFetching ||
              selectAllMutation.isPending
            }
          />

          <footer className="task-pagination" aria-label="Пагинация задач">
            <p>
              {((search.data.page - 1) * search.data.pageSize + 1).toLocaleString('ru-RU')}–
              {Math.min(
                search.data.page * search.data.pageSize,
                search.data.total,
              ).toLocaleString('ru-RU')}{' '}
              из {search.data.total.toLocaleString('ru-RU')}
            </p>
            <label>
              На странице
              <select
                aria-disabled={search.isError || search.isFetching}
                onChange={(event) => {
                  if (!search.isError && !search.isFetching) {
                    changePageSize(Number(event.target.value));
                  }
                }}
                value={search.data.pageSize}
              >
                <option value="25">25</option>
                <option value="50">50</option>
              </select>
            </label>
            <div className="task-page-actions">
              <button
                aria-disabled={search.data.page <= 1 || search.isError || search.isFetching}
                className="button-secondary"
                onClick={() => {
                  if (search.data!.page > 1 && !search.isError && !search.isFetching) {
                    changePage(search.data!.page - 1);
                  }
                }}
                type="button"
              >
                Назад
              </button>
              <span>
                Страница {search.data.page.toLocaleString('ru-RU')} из{' '}
                {Math.max(
                  1,
                  Math.ceil(search.data.total / search.data.pageSize),
                ).toLocaleString('ru-RU')}
              </span>
              <button
                aria-disabled={
                  !search.data.hasNextPage || search.isError || search.isFetching
                }
                className="button-secondary"
                onClick={() => {
                  if (search.data!.hasNextPage && !search.isError && !search.isFetching) {
                    changePage(search.data!.page + 1);
                  }
                }}
                type="button"
              >
                Далее
              </button>
            </div>
          </footer>
        </Card>
      ) : null}

      {selectedTaskIds.size > 0 ? (
        <aside className="task-selection-dock" aria-label="Выбранные задачи">
          <div>
            <strong>Выбрано: {selectedTaskIds.size.toLocaleString('ru-RU')}</strong>
            <span>
              {currentOperationDraft.isError
                ? 'Не удалось проверить сохранённый черновик.'
                : 'Лимит одной операции — 1 000 задач'}
            </span>
          </div>
          <button className="button-link" onClick={clearSelectionState} type="button">
            Очистить
          </button>
          <button
            className="button-primary"
            disabled={
              selectAllMutation.isPending ||
              (app ? !canStartBulkChange(app) : false) ||
              (app !== null && (currentOperationDraft.isPending || currentOperationDraft.isError))
            }
            onClick={configureChanges}
            ref={configureButtonRef}
            type="button"
          >
            Настроить изменения
          </button>
        </aside>
      ) : null}

      {dialogMode ? (
        <SavedFilterDialog
          error={savedError}
          initialName={dialogMode === 'rename' ? (selectedSaved?.name ?? '') : ''}
          key={`${dialogMode}-${selectedSaved?.id ?? 'new'}`}
          mode={dialogMode}
          onClose={() => {
            if (!saveMutation.isPending) setDialogMode(null);
          }}
          onSubmit={submitSavedFilter}
          pending={saveMutation.isPending}
        />
      ) : null}
      <Modal
        description="Можно продолжить сохранённую настройку или явно заменить её текущим выбором задач."
        onClose={() => setDraftChoiceOpen(false)}
        open={draftChoiceOpen}
        returnFocusRef={configureButtonRef}
        title="Найден черновик массовой операции"
      >
        <div className="dialog-actions">
          <button
            className="button-secondary"
            onClick={() => setDraftChoiceOpen(false)}
            type="button"
          >
            Отмена
          </button>
          <button className="button-secondary" onClick={() => openEditor(null)} type="button">
            Начать заново
          </button>
          <button
            className="button-primary"
            onClick={() => openEditor(currentOperationDraft.data?.draft ?? null)}
            type="button"
          >
            Продолжить черновик
          </button>
        </div>
      </Modal>
      <Modal
        description={
          'Изменение фильтра очищает выбор. ' +
          'Задачи с других страниц потребуется выбрать заново.'
        }
        onClose={() => setPendingSelectionReset(null)}
        open={pendingSelectionReset !== null}
        returnFocusRef={filterBuilderHeadingRef}
        title="Изменить фильтр и снять выбор?"
      >
        <div className="dialog-actions">
          <button
            className="button-secondary"
            onClick={() => setPendingSelectionReset(null)}
            type="button"
          >
            Отмена
          </button>
          <button
            className="button-primary"
            onClick={() => {
              const pending = pendingSelectionReset;
              setPendingSelectionReset(null);
              pending?.apply();
            }}
            type="button"
          >
            Снять выбор и продолжить
          </button>
        </div>
      </Modal>
      <Modal
        description="Набор исчезнет только из вашей учётной записи."
        onClose={() => {
          if (!deleteMutation.isPending) setDeleteOpen(false);
        }}
        open={deleteOpen}
        title="Удалить набор фильтров?"
      >
        {savedError ? <InlineError details={savedError} /> : null}
        {deleteMutation.isPending ? <p role="status">Удаляем набор…</p> : null}
        <div className="dialog-actions">
          <button
            className="button-secondary"
            disabled={deleteMutation.isPending}
            onClick={() => setDeleteOpen(false)}
            type="button"
          >
            Отмена
          </button>
          <button
            className="button-primary task-danger-button"
            disabled={!selectedSaved || deleteMutation.isPending}
            onClick={() => selectedSaved && deleteMutation.mutate(selectedSaved)}
            type="button"
          >
            {deleteMutation.isPending ? 'Удаление…' : 'Удалить'}
          </button>
        </div>
      </Modal>
    </div>
  );
}
