import { useForm } from '@tanstack/react-form';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  BulkOperationDraft,
  TaskChangeAction,
  TaskChangeCatalogResponse,
  TaskChangeField,
  TaskFilterList,
  TaskSearchApiRequest,
} from '@task-commander/contracts';

import { bulkChangeAccessFingerprint, canStartBulkChange } from '@/app/access-policy';
import {
  AppApiError,
  fetchTaskChangeCatalog,
  saveBulkOperationDraft,
  searchTaskFilterUsers,
} from '@/app/app-api';
import { useAppAccess } from '@/app/app-context';
import { AppState } from '@/components/ui/app-state';
import { Card } from '@/components/ui/card';

import {
  bulkChangeDraftsFromCommands,
  changeBulkChangeAction,
  createBulkChangeDraft,
  hasCompatibleOptionValues,
  parseBulkChangeDrafts,
  type BulkChangeDraft,
} from './bulk-change-model';

type Props = {
  selectedTaskIds: readonly string[];
  filters: TaskFilterList;
  sort: TaskSearchApiRequest['sort'];
  initialDraft: BulkOperationDraft | null;
  initialRevision: number;
  replaceExpired: boolean;
  onBack(): void;
  onSaved(draft: BulkOperationDraft): void;
};

const actionLabels: Readonly<Record<TaskChangeAction, string>> = {
  set: 'Установить значение',
  clear: 'Очистить',
  shift: 'Сдвинуть дату',
  replace: 'Заменить набор',
  add: 'Добавить к набору',
  remove: 'Удалить из набора',
};

function countLabel(count: number, forms: [string, string, string]): string {
  const modulo100 = count % 100;
  const modulo10 = count % 10;
  const form =
    modulo100 >= 11 && modulo100 <= 14
      ? forms[2]
      : modulo10 === 1
        ? forms[0]
        : modulo10 >= 2 && modulo10 <= 4
          ? forms[1]
          : forms[2];
  return `${count.toLocaleString('ru-RU')} ${form}`;
}

function editorError(error: unknown): string {
  if (error instanceof AppApiError) {
    if (error.kind === 'offline') return 'Нет соединения. Черновик не сохранён.';
    if (error.status === 409) {
      return 'Черновик изменён в другой вкладке. Вернитесь к выбору и загрузите актуальную версию.';
    }
    if (error.kind === 'access_denied') return 'Право на настройку изменений отозвано.';
    return 'Не удалось сохранить черновик.';
  }
  return 'Не удалось сохранить черновик.';
}

function UserPicker({
  values,
  multiple,
  errorId,
  invalid,
  onChange,
}: {
  values: string[];
  multiple: boolean;
  errorId?: string;
  invalid: boolean;
  onChange(values: string[]): void;
}) {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [labels, setLabels] = useState<Record<string, string>>({});
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => window.clearTimeout(timeout);
  }, [query]);
  const users = useInfiniteQuery({
    queryKey: ['task-change-users', debouncedQuery],
    queryFn: ({ signal, pageParam }) =>
      searchTaskFilterUsers({ q: debouncedQuery, cursor: pageParam, pageSize: 20 }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: debouncedQuery.length === 0 || debouncedQuery.length >= 2,
    staleTime: 30_000,
  });
  const items = useMemo(
    () => [
      ...new Map(
        (users.data?.pages.flatMap((page) => page.items) ?? []).map((user) => [user.id, user]),
      ).values(),
    ],
    [users.data],
  );
  useEffect(() => {
    if (items.length > 0) {
      setLabels((current) => ({
        ...current,
        ...Object.fromEntries(items.map((item) => [item.id, item.displayName])),
      }));
    }
  }, [items]);
  return (
    <div
      aria-describedby={invalid ? errorId : undefined}
      aria-invalid={invalid || undefined}
      className="task-user-picker"
    >
      <input
        aria-describedby={invalid ? errorId : undefined}
        aria-invalid={invalid || undefined}
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
              aria-label={`Удалить ${labels[value] ?? value}`}
              key={value}
              onClick={() => onChange(values.filter((item) => item !== value))}
              type="button"
            >
              {labels[value] ?? `ID ${value}`} ×
            </button>
          ))}
        </div>
      ) : null}
      {query.trim().length === 1 ? <small>Введите минимум два символа.</small> : null}
      {users.isFetching && !users.isFetchingNextPage ? (
        <small role="status">Загрузка сотрудников…</small>
      ) : null}
      {users.isError ? <small role="alert">Не удалось загрузить сотрудников.</small> : null}
      {users.data ? (
        <fieldset className="task-user-results">
          <legend className="sr-only">Результаты поиска сотрудников</legend>
          {items.map((user) => (
            <label key={user.id}>
              <input
                checked={values.includes(user.id)}
                disabled={!values.includes(user.id) && (multiple ? values.length >= 256 : false)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? multiple
                        ? [...values, user.id]
                        : [user.id]
                      : values.filter((item) => item !== user.id),
                  )
                }
                type={multiple ? 'checkbox' : 'radio'}
              />
              <span>{user.displayName}</span>
            </label>
          ))}
          {items.length === 0 ? <small>Сотрудники не найдены.</small> : null}
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

function ValueInput({
  field,
  draft,
  errorId,
  invalid,
  onChange,
}: {
  field: TaskChangeField;
  draft: BulkChangeDraft;
  errorId?: string;
  invalid: boolean;
  onChange(next: BulkChangeDraft): void;
}) {
  if (draft.action === 'clear') {
    return <p className="bulk-change-help">Поле будет очищено во всех допущенных задачах.</p>;
  }
  if (draft.action === 'shift') {
    return (
      <div className="bulk-change-shift-grid">
        <label>
          Направление
          <select
            onChange={(event) =>
              onChange({ ...draft, direction: event.target.value as BulkChangeDraft['direction'] })
            }
            value={draft.direction}
          >
            <option value="forward">Вперёд</option>
            <option value="backward">Назад</option>
          </select>
        </label>
        <label>
          Количество дней
          <input
            aria-describedby={invalid ? errorId : undefined}
            aria-invalid={invalid || undefined}
            inputMode="numeric"
            max={3660}
            min={1}
            onChange={(event) => onChange({ ...draft, days: event.target.value })}
            type="number"
            value={draft.days}
          />
        </label>
        <label>
          Тип дней
          <select
            onChange={(event) =>
              onChange({ ...draft, calendar: event.target.value as BulkChangeDraft['calendar'] })
            }
            value={draft.calendar}
          >
            <option value="calendar_days">Календарные</option>
            <option value="working_days">Рабочие</option>
          </select>
        </label>
        <p className="bulk-change-help">Время задачи сохраняется; меняется только дата.</p>
      </div>
    );
  }

  const collectionAction = ['replace', 'add', 'remove'].includes(draft.action);
  if (field.valueSource === 'users') {
    const values = collectionAction ? draft.values : draft.value ? [draft.value] : [];
    return (
      <UserPicker
        errorId={errorId}
        invalid={invalid}
        multiple={collectionAction}
        onChange={(next) =>
          onChange(
            collectionAction ? { ...draft, values: next } : { ...draft, value: next[0] ?? '' },
          )
        }
        values={values}
      />
    );
  }
  if (field.valueSource === 'options') {
    if (collectionAction) {
      return (
        <fieldset
          aria-describedby={invalid ? errorId : undefined}
          aria-invalid={invalid || undefined}
          className="bulk-change-options"
        >
          <legend>Значения</legend>
          {field.options.map((option) => (
            <label key={option.value}>
              <input
                checked={draft.values.includes(option.value)}
                onChange={(event) =>
                  onChange({
                    ...draft,
                    values: event.target.checked
                      ? [...draft.values, option.value]
                      : draft.values.filter((value) => value !== option.value),
                  })
                }
                type="checkbox"
              />
              {option.label}
            </label>
          ))}
        </fieldset>
      );
    }
    return (
      <label>
        Значение
        <select
          aria-describedby={invalid ? errorId : undefined}
          aria-invalid={invalid || undefined}
          onChange={(event) => onChange({ ...draft, value: event.target.value })}
          value={draft.value}
        >
          <option value="">Выберите значение</option>
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (collectionAction) {
    return (
      <label>
        Значения через запятую
        <textarea
          aria-describedby={invalid ? errorId : undefined}
          aria-invalid={invalid || undefined}
          onChange={(event) =>
            onChange({
              ...draft,
              values: event.target.value.split(',').map((value) => value.trim()),
            })
          }
          rows={3}
          value={draft.values.join(', ')}
        />
      </label>
    );
  }
  if (field.kind === 'boolean') {
    return (
      <label>
        Значение
        <select
          aria-describedby={invalid ? errorId : undefined}
          aria-invalid={invalid || undefined}
          onChange={(event) => onChange({ ...draft, value: event.target.value })}
          value={draft.value}
        >
          <option value="">Выберите значение</option>
          <option value="true">Да</option>
          <option value="false">Нет</option>
        </select>
      </label>
    );
  }
  if (field.kind === 'text') {
    return (
      <label>
        Значение
        <textarea
          aria-describedby={invalid ? errorId : undefined}
          aria-invalid={invalid || undefined}
          maxLength={4096}
          onChange={(event) => onChange({ ...draft, value: event.target.value })}
          rows={field.id === 'description' ? 8 : 3}
          value={draft.value}
        />
      </label>
    );
  }
  return (
    <label>
      Значение
      <input
        aria-describedby={invalid ? errorId : undefined}
        aria-invalid={invalid || undefined}
        onChange={(event) => onChange({ ...draft, value: event.target.value })}
        type={
          field.kind === 'date_time'
            ? 'datetime-local'
            : field.kind === 'number'
              ? 'number'
              : 'text'
        }
        value={draft.value}
      />
    </label>
  );
}

export function BulkChangeEditor({
  selectedTaskIds,
  filters,
  sort,
  initialDraft,
  initialRevision,
  replaceExpired,
  onBack,
  onSaved,
}: Props) {
  const app = useAppAccess();
  const queryClient = useQueryClient();
  const [activeFieldId, setActiveFieldId] = useState('');
  const [fieldToAdd, setFieldToAdd] = useState('');
  const [formErrors, setFormErrors] = useState<Readonly<Record<string, string>>>({});
  const [notice, setNotice] = useState('');
  const [savedAt, setSavedAt] = useState('');
  const [revision, setRevision] = useState(initialRevision);
  const initializedDraftId = useRef<string | null>(null);
  const previousCatalog = useRef<TaskChangeCatalogResponse | null>(null);
  const addSelectRef = useRef<HTMLSelectElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const editVersion = useRef(0);
  const submittedEditVersion = useRef<number | null>(null);
  const accessFingerprint = app ? bulkChangeAccessFingerprint(app) : 'isolated';
  const canMutate = app ? canStartBulkChange(app) : true;
  const catalog = useQuery({
    queryKey: ['task-change-catalog', app?.generation ?? 0, accessFingerprint],
    queryFn: ({ signal }) => fetchTaskChangeCatalog(signal),
    enabled: canMutate,
    staleTime: 60_000,
  });
  const saveMutation = useMutation({
    mutationFn: (input: Parameters<typeof saveBulkOperationDraft>[0]) =>
      saveBulkOperationDraft(input),
    onSuccess: (draft) => {
      setRevision(draft.revision);
      setSavedAt(
        submittedEditVersion.current === editVersion.current ? new Date().toISOString() : '',
      );
      queryClient.setQueryData(['bulk-operation-draft', app?.generation ?? 0, accessFingerprint], {
        draft,
      });
      onSaved(draft);
    },
    onError: (error) => {
      if (error instanceof AppApiError && error.status === 409) {
        void queryClient.invalidateQueries({ queryKey: ['bulk-operation-draft'] });
      }
    },
  });
  const form = useForm({
    defaultValues: { changes: [] as BulkChangeDraft[] },
    onSubmit: async ({ value }) => {
      if (!catalog.data) return;
      const parsed = parseBulkChangeDrafts(value.changes, catalog.data);
      if (!parsed.success) {
        setFormErrors(parsed.errors);
        return;
      }
      setFormErrors({});
      setNotice('');
      submittedEditVersion.current = editVersion.current;
      await saveMutation.mutateAsync({
        expectedRevision: revision,
        replaceExpired,
        selectedTaskIds: [...selectedTaskIds],
        filters,
        sort,
        changes: parsed.commands,
      });
    },
  });

  useEffect(() => {
    if (catalog.isSuccess) headingRef.current?.focus();
  }, [catalog.isSuccess]);

  useEffect(() => {
    if (!catalog.data || !initialDraft || initializedDraftId.current === initialDraft.id) return;
    const restored = bulkChangeDraftsFromCommands(initialDraft.changes, catalog.data);
    form.reset({ changes: restored });
    setActiveFieldId(restored[0]?.fieldId ?? '');
    if (restored.length !== initialDraft.changes.length) {
      setNotice('Недоступные поля удалены из восстановленного черновика. Сохраните новую ревизию.');
    }
    initializedDraftId.current = initialDraft.id;
  }, [catalog.data, form, initialDraft]);

  useEffect(() => {
    if (!catalog.data || (initialDraft && initializedDraftId.current !== initialDraft.id)) return;
    const current = form.store.state.values.changes;
    const fields = new Map(catalog.data.fields.map((field) => [field.id, field]));
    const previousFields = new Map(
      previousCatalog.current?.fields.map((field) => [field.id, field]),
    );
    let changed = false;
    const compatible = current.flatMap((draft) => {
      const field = fields.get(draft.fieldId);
      if (!field) {
        changed = true;
        return [];
      }
      const previousField = previousFields.get(draft.fieldId);
      const shapeChanged =
        previousField !== undefined &&
        (previousField.kind !== field.kind ||
          previousField.isMultiple !== field.isMultiple ||
          previousField.valueSource !== field.valueSource);
      if (shapeChanged || !hasCompatibleOptionValues(draft, field)) {
        changed = true;
        return [createBulkChangeDraft(field)];
      }
      if (!field.actions.includes(draft.action)) {
        changed = true;
        return [changeBulkChangeAction(draft, field, field.actions[0]!)];
      }
      return [draft];
    });
    previousCatalog.current = catalog.data;
    if (fieldToAdd && !fields.has(fieldToAdd)) {
      changed = true;
      setFieldToAdd('');
    }
    if (changed) {
      editVersion.current += 1;
      form.setFieldValue('changes', compatible);
      setActiveFieldId((currentFieldId) =>
        compatible.some((draft) => draft.fieldId === currentFieldId)
          ? currentFieldId
          : (compatible[0]?.fieldId ?? ''),
      );
      setNotice('Схема доступа изменилась. Недоступные или несовместимые настройки удалены.');
      setSavedAt('');
    }
  }, [catalog.data, fieldToAdd, form, initialDraft]);

  if (!canMutate) {
    return (
      <AppState
        action={
          <button className="button-secondary" onClick={onBack} type="button">
            Назад к задачам
          </button>
        }
        description="Текущие права не разрешают подготовку массовой операции."
        title="Настройка изменений недоступна"
      />
    );
  }
  if (catalog.isPending) {
    return (
      <AppState
        title="Загрузка разрешённых полей"
        description="Проверяем актуальные права и возможности Bitrix24."
      />
    );
  }
  if (catalog.isError) {
    return (
      <AppState
        action={
          <>
            <button className="button-secondary" onClick={onBack} type="button">
              Назад к задачам
            </button>
            <button
              className="button-secondary"
              onClick={() => void catalog.refetch()}
              type="button"
            >
              Повторить
            </button>
          </>
        }
        description="Редактор закрыт до успешной проверки прав и возможностей полей."
        title="Не удалось загрузить поля"
      />
    );
  }
  if (catalog.data.fields.length === 0) {
    return (
      <AppState
        action={
          <button className="button-secondary" onClick={onBack} type="button">
            Назад к задачам
          </button>
        }
        description="Администратор не разрешил ни одного поддерживаемого поля."
        title="Нет доступных полей"
      />
    );
  }

  return (
    <form
      className="bulk-change-page"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit().catch(() => undefined);
      }}
    >
      <nav aria-label="Этапы массового изменения" className="breadcrumbs">
        <span>Выбор задач</span>
        <i>/</i>
        <strong>Настройка изменений</strong>
        <i>/</i>
        <span>Проверка</span>
        <i>/</i>
        <span>Выполнение</span>
      </nav>
      <header className="bulk-change-heading">
        <div>
          <span className="eyebrow">Шаг 2 из 4</span>
          <h1 ref={headingRef} tabIndex={-1}>
            Настройка изменений
          </h1>
          <p>Задайте поля и значения. Фактическое изменение задач на этом шаге не выполняется.</p>
        </div>
        <strong>{countLabel(selectedTaskIds.length, ['задача', 'задачи', 'задач'])}</strong>
      </header>
      {notice ? (
        <p className="bulk-change-notice" role="status">
          {notice}
        </p>
      ) : null}
      {saveMutation.isError ? (
        <p className="task-inline-error" role="alert">
          {editorError(saveMutation.error)}
        </p>
      ) : null}
      <form.Field name="changes" mode="array">
        {(changesField) => {
          const drafts = changesField.state.value;
          const used = new Set(drafts.map((draft) => draft.fieldId));
          const available = catalog.data.fields.filter((field) => !used.has(field.id));
          const activeIndex = Math.max(
            0,
            drafts.findIndex((draft) => draft.fieldId === activeFieldId),
          );
          const activeDraft = drafts[activeIndex];
          const activeField = activeDraft
            ? catalog.data.fields.find((field) => field.id === activeDraft.fieldId)
            : undefined;
          const updateDraft = (next: BulkChangeDraft) => {
            editVersion.current += 1;
            changesField.replaceValue(activeIndex, next);
            setSavedAt('');
            setFormErrors({});
          };
          return (
            <>
              <div className="bulk-change-layout">
                <Card className="bulk-change-list-panel">
                  <div className="bulk-change-panel-heading">
                    <div>
                      <h2>Поля операции</h2>
                      <span>{drafts.length} из 64</span>
                    </div>
                    <p>Каждое поле добавляется один раз.</p>
                  </div>
                  <div className="bulk-change-add-row">
                    <label>
                      Добавить поле
                      <select
                        onChange={(event) => setFieldToAdd(event.target.value)}
                        ref={addSelectRef}
                        value={fieldToAdd}
                      >
                        <option value="">Выберите поле</option>
                        <optgroup label="Основные поля">
                          {available
                            .filter((field) => !field.id.startsWith('UF_'))
                            .map((field) => (
                              <option key={field.id} value={field.id}>
                                {field.label}
                              </option>
                            ))}
                        </optgroup>
                        {available.some((field) => field.id.startsWith('UF_')) ? (
                          <optgroup label="Пользовательские поля">
                            {available
                              .filter((field) => field.id.startsWith('UF_'))
                              .map((field) => (
                                <option key={field.id} value={field.id}>
                                  {field.label}
                                </option>
                              ))}
                          </optgroup>
                        ) : null}
                      </select>
                    </label>
                    <button
                      className="button-secondary"
                      disabled={!fieldToAdd || drafts.length >= 64}
                      onClick={() => {
                        const field = catalog.data.fields.find((item) => item.id === fieldToAdd);
                        if (!field) return;
                        editVersion.current += 1;
                        changesField.pushValue(createBulkChangeDraft(field));
                        setActiveFieldId(field.id);
                        setFieldToAdd('');
                        setSavedAt('');
                        setFormErrors({});
                      }}
                      type="button"
                    >
                      Добавить
                    </button>
                  </div>
                  {drafts.length > 0 ? (
                    <ol className="bulk-change-list">
                      {drafts.map((draft, index) => {
                        const field = catalog.data.fields.find((item) => item.id === draft.fieldId);
                        if (!field) return null;
                        return (
                          <li
                            className={index === activeIndex ? 'is-active' : undefined}
                            key={draft.fieldId}
                          >
                            <button
                              aria-current={index === activeIndex ? 'true' : undefined}
                              onClick={() => setActiveFieldId(draft.fieldId)}
                              type="button"
                            >
                              <strong>{field.label}</strong>
                              <span>{actionLabels[draft.action]}</span>
                            </button>
                            <button
                              aria-label={`Удалить поле ${field.label}`}
                              className="bulk-change-remove"
                              onClick={() => {
                                editVersion.current += 1;
                                changesField.removeValue(index);
                                const next = drafts[index + 1] ?? drafts[index - 1];
                                if (draft.fieldId === activeFieldId) {
                                  setActiveFieldId(next?.fieldId ?? '');
                                }
                                setSavedAt('');
                                setFormErrors({});
                                window.setTimeout(() => addSelectRef.current?.focus(), 0);
                              }}
                              type="button"
                            >
                              Удалить
                            </button>
                          </li>
                        );
                      })}
                    </ol>
                  ) : (
                    <div className="bulk-change-empty">
                      <strong>Изменения не добавлены</strong>
                      <p>Выберите первое поле, чтобы настроить операцию.</p>
                    </div>
                  )}
                </Card>
                <Card className="bulk-change-editor-panel">
                  {activeDraft && activeField ? (
                    <>
                      <div className="bulk-change-panel-heading">
                        <div>
                          <h2>{activeField.label}</h2>
                          <code>{activeField.id}</code>
                        </div>
                        <p>Настройка применяется ко всем задачам, которые пройдут проверку.</p>
                      </div>
                      <div className="bulk-change-control-stack">
                        <label>
                          Операция
                          <select
                            aria-describedby={`change-help-${activeField.id}`}
                            onChange={(event) =>
                              updateDraft(
                                changeBulkChangeAction(
                                  activeDraft,
                                  activeField,
                                  event.target.value as TaskChangeAction,
                                ),
                              )
                            }
                            value={activeDraft.action}
                          >
                            {activeField.actions.map((action) => (
                              <option key={action} value={action}>
                                {actionLabels[action]}
                              </option>
                            ))}
                          </select>
                        </label>
                        <p className="bulk-change-help" id={`change-help-${activeField.id}`}>
                          {activeDraft.action === 'add'
                            ? 'Новые значения добавятся к существующим.'
                            : activeDraft.action === 'remove'
                              ? 'Будут удалены только указанные значения.'
                              : activeDraft.action === 'replace'
                                ? 'Текущий набор значений будет полностью заменён.'
                                : activeDraft.action === 'shift'
                                  ? 'Дата сдвигается относительно текущего значения каждой задачи.'
                                  : activeDraft.action === 'clear'
                                    ? 'Текущее значение поля будет очищено.'
                                    : 'Будет установлено указанное значение.'}
                        </p>
                        <ValueInput
                          draft={activeDraft}
                          errorId={`change-error-${activeField.id}`}
                          field={activeField}
                          invalid={Boolean(formErrors[activeField.id])}
                          onChange={updateDraft}
                        />
                        {formErrors[activeField.id] ? (
                          <p
                            className="bulk-change-field-error"
                            id={`change-error-${activeField.id}`}
                            role="alert"
                          >
                            {formErrors[activeField.id]}
                          </p>
                        ) : null}
                      </div>
                    </>
                  ) : (
                    <div className="bulk-change-empty">
                      <strong>Выберите поле слева</strong>
                      <p>Здесь появятся операция, значение и правила изменения.</p>
                    </div>
                  )}
                </Card>
              </div>
              {formErrors.form ? (
                <p className="bulk-change-field-error" role="alert">
                  {formErrors.form}
                </p>
              ) : null}
              <footer className="bulk-change-footer">
                <div>
                  <strong>
                    {countLabel(selectedTaskIds.length, ['задача', 'задачи', 'задач'])} ·{' '}
                    {countLabel(drafts.length, ['поле', 'поля', 'полей'])}
                  </strong>
                  <span>
                    {savedAt
                      ? 'Черновик сохранён на 24 часа.'
                      : 'Проверка и запись в задачи ещё не выполнялись.'}
                  </span>
                </div>
                <button
                  className="button-secondary"
                  disabled={saveMutation.isPending}
                  onClick={onBack}
                  type="button"
                >
                  Назад к задачам
                </button>
                <button
                  className="button-secondary"
                  disabled={drafts.length === 0 || saveMutation.isPending}
                  type="submit"
                >
                  {saveMutation.isPending ? 'Сохранение…' : 'Сохранить черновик'}
                </button>
                <button
                  className="button-primary"
                  disabled
                  title="Расчёт и предварительная проверка реализуются в задачах 018–019"
                  type="button"
                >
                  Проверить изменения
                </button>
              </footer>
            </>
          );
        }}
      </form.Field>
    </form>
  );
}
