import type { AccessChangeMode, AccessChangeReason } from '@task-commander/contracts';
import { Button } from '@base-ui/react/button';
import { useForm } from '@tanstack/react-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';

import { notifyAccessInvalidated } from '@/app/access-sync';
import { useAppAccess } from '@/app/app-context';
import { Icons } from '@/components/ui/icons';
import { Modal } from '@/components/ui/modal';

import {
  AccessApiError,
  accessErrorMessage,
  createCommand,
  createPreflight,
  confirmPreflight,
  fetchCapabilities,
  fetchCommand,
  fetchDraftRevision,
  fetchFieldSetMembers,
  fetchFields,
  fetchPreflight,
  fetchUser,
  fetchUsers,
  saveDraft,
} from './access-api';
import type { AccessDraft, AccessUser } from './access-types';

const permissionOptions = [
  ['app_access', 'Вход и просмотр задач'],
  ['run_bulk_operations', 'Запуск массовых операций'],
  ['change_allowed_fields', 'Изменение разрешённых полей'],
  ['retry_operations', 'Повторный прогон'],
  ['restore_operations', 'Восстановление предыдущих значений'],
  ['view_own_reports', 'Просмотр собственных отчётов'],
  ['view_all_reports', 'Просмотр всех отчётов'],
  ['export_reports', 'Экспорт отчётов'],
  ['view_audit', 'Просмотр журнала аудита'],
  ['manage_access', 'Управление доступом'],
] as const;
const permissionLabels = new Map<string, string>(permissionOptions);
const permissionListLabel = (permissions: readonly string[]) =>
  permissions.map((permission) => permissionLabels.get(permission) ?? permission).join(', ') ||
  'нет';

const defaultAccessSettings: Pick<AccessDraft, 'permissions' | 'fieldIds'> = {
  permissions: ['app_access'],
  fieldIds: [],
};
const defaultAccessMode: AccessChangeMode = 'grant';

const reasonOptions = [
  ['role_change', 'Изменилась роль сотрудника'],
  ['responsibility_change', 'Изменилась зона ответственности'],
  ['security_policy', 'Требование политики безопасности'],
  ['access_cleanup', 'Плановая очистка доступа'],
  ['employee_request', 'Запрос сотрудника'],
  ['other', 'Другая причина'],
] as const;

const preflightStateLabels = {
  ready: 'готово',
  excluded: 'исключено',
  conflict: 'настройки изменились',
  no_change: 'без изменений',
} as const;

const targetReasonLabels: Record<string, string> = {
  ADMIN_ACCESS_IMMUTABLE: 'доступ администратора неизменяем',
  EMPLOYEE_INACTIVE: 'сотрудник неактивен',
  EMPLOYMENT_STATE_UNKNOWN: 'статус сотрудника не подтверждён',
  TARGET_ACCESS_CHANGED: 'настройки изменились после проверки',
  ACTOR_ACCESS_CHANGED: 'ваши полномочия изменились',
  PERMISSION_CATALOG_CHANGED: 'каталог прав обновился',
  NOTIFICATION_FAILED: 'уведомление не отправлено',
  INTERNAL_ERROR: 'внутренняя ошибка',
};

function createReason(code: string, comment: string): AccessChangeReason | null {
  switch (code) {
    case 'role_change':
    case 'responsibility_change':
    case 'security_policy':
    case 'access_cleanup':
    case 'employee_request':
      return { code };
    case 'other':
      return { code, comment: comment.trim() };
    default:
      return null;
  }
}

function WorkflowHeader({ title, description }: { title: string; description: string }) {
  return (
    <>
      <nav aria-label="Хлебные крошки" className="breadcrumbs">
        <Link to="/access">Система</Link>
        <i>/</i>
        <Link to="/access">Доступ</Link>
        <i>/</i>
        <strong>{title}</strong>
      </nav>
      <header className="workflow-heading">
        <h1 tabIndex={-1}>{title}</h1>
        <p>{description}</p>
      </header>
    </>
  );
}

function WorkflowState({
  title,
  description,
  retry,
}: {
  title: string;
  description: string;
  retry?: () => void;
}) {
  return (
    <section className="workflow-card workflow-state" role="status">
      <span className="state-icon">
        <Icons.info />
      </span>
      <h2>{title}</h2>
      <p>{description}</p>
      {retry && (
        <Button className="button-secondary" onClick={retry}>
          Повторить
        </Button>
      )}
    </section>
  );
}

export function AccessConfigurePage({ subjectIds }: { subjectIds: string[] }) {
  const app = useAppAccess();
  const canMutate = app?.canMutate === true && app.accessManagement === 'allowed';
  const navigate = useNavigate({ from: '/access/configure' });
  const capabilities = useQuery({
    queryKey: ['access-management', 'capabilities'],
    queryFn: fetchCapabilities,
    retry: 1,
  });
  const fields = useQuery({
    queryKey: ['access-management', 'fields'],
    queryFn: () => fetchFields(''),
  });
  const subjects = useQuery({
    queryKey: ['access-management', 'users', 'profiles', subjectIds],
    queryFn: async () => {
      const users: AccessUser[] = [];
      const failedIds: string[] = [];
      for (let offset = 0; offset < subjectIds.length; offset += 5) {
        const ids = subjectIds.slice(offset, offset + 5);
        const results = await Promise.allSettled(ids.map((id) => fetchUser(id)));
        results.forEach((result, index) => {
          if (result.status === 'fulfilled') users.push(result.value);
          else if (ids[index]) failedIds.push(ids[index]);
        });
      }
      return { users, failedIds };
    },
    enabled: subjectIds.length > 0,
    retry: 1,
  });
  const [submitError, setSubmitError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [draftRevision, setDraftRevision] = useState<number | null>(null);
  const [fieldSearch, setFieldSearch] = useState('');
  const [visibleFieldCount, setVisibleFieldCount] = useState(100);
  const initializedCurrentAccess = useRef('');
  const draftState = useQuery({
    queryKey: ['access-management', 'draft', 'revision'],
    queryFn: fetchDraftRevision,
    retry: 1,
  });
  const users = subjects.data?.users ?? [];
  const availableModes =
    users.length === 0
      ? []
      : (users[0]?.availableModes.filter((mode) =>
          users.every((user) => user.availableModes.includes(mode)),
        ) ?? []);
  const primaryFieldScope = users.length === 1 ? users[0]?.fieldScope : null;
  const shouldLoadCurrentFields =
    users.length === 1 && Boolean(fields.data) && Boolean(primaryFieldScope);
  const currentFieldIds = useQuery({
    queryKey: [
      'access-management',
      'field-set',
      primaryFieldScope?.kind === 'set' ? primaryFieldScope.fieldSetId : 'none',
      primaryFieldScope?.kind === 'set' ? primaryFieldScope.version : 0,
    ],
    queryFn: () =>
      primaryFieldScope?.kind === 'set'
        ? fetchFieldSetMembers({ ...primaryFieldScope, targetUserId: users[0]?.id ?? '' })
        : Promise.resolve(fields.data?.map((field) => field.id) ?? []),
    enabled: shouldLoadCurrentFields,
  });
  const form = useForm({
    defaultValues: {
      mode: defaultAccessMode,
      permissions: [...defaultAccessSettings.permissions],
      fieldIds: [...defaultAccessSettings.fieldIds],
      reasonCode: '',
      reasonComment: '',
    },
    onSubmit: async ({ value }) => {
      setSubmitError('');
      if (!availableModes.includes(value.mode)) {
        setSubmitError(
          'Выберите доступный способ изменения. Полномочия и состояние получателей были проверены сервером.',
        );
        return;
      }
      const reason = createReason(value.reasonCode, value.reasonComment);
      if ((value.mode === 'revoke_managed' || value.mode === 'full_revoke') && !reason) {
        setSubmitError('Укажите причину сокращения или отзыва доступа.');
        return;
      }
      if (reason?.code === 'other' && reason.comment.length < 10) {
        setSubmitError('Опишите другую причину минимум в 10 символах.');
        return;
      }
      if (!canMutate || submitting) return;
      setSubmitting(true);
      try {
        const draft: AccessDraft = {
          subjectIds,
          subjectVersions: Object.fromEntries(users.map((user) => [user.id, user.accessVersion])),
          draftRevision: draftRevision ?? 0,
          mode: value.mode,
          permissions: value.permissions,
          fieldIds: value.fieldIds,
          reason,
          permissionCatalogVersion: capabilities.data?.permissionCatalogVersion ?? 1,
          actorAccessVersion: capabilities.data?.actorAccessVersion ?? 1,
        };
        const savedDraft = await saveDraft(draft);
        setDraftRevision(savedDraft.draftRevision);
        const preflight = await createPreflight(savedDraft);
        await navigate({ to: '/access/review', search: { preflight: preflight.preflightId } });
      } catch (error) {
        if (error instanceof Error && 'status' in error && error.status === 409) {
          setSubmitError(
            'Черновик изменён в другой вкладке или уже отправлен. Данные этой вкладки не применены. Обновите страницу и проверьте актуальный черновик.',
          );
          return;
        }
        setSubmitError(accessErrorMessage(error, 'Не удалось проверить настройки.'));
      } finally {
        setSubmitting(false);
      }
    },
  });

  useEffect(() => {
    if (draftRevision === null && draftState.data !== undefined) {
      setDraftRevision(draftState.data);
    }
  }, [draftRevision, draftState.data]);

  useEffect(() => {
    const current = form.getFieldValue('mode');
    if (!availableModes.includes(current) && availableModes[0]) {
      const next = availableModes[0];
      form.setFieldValue('mode', next);
      if (next === 'repair' && users[0]) {
        form.setFieldValue('permissions', users[0].permissions);
        form.setFieldValue('fieldIds', currentFieldIds.data ?? []);
      }
    }
  }, [availableModes, currentFieldIds.data, form, users]);

  useEffect(() => {
    const mode = form.getFieldValue('mode');
    const user = users[0];
    if (
      user &&
      currentFieldIds.data &&
      (mode === 'repair' || mode === 'replace_managed') &&
      initializedCurrentAccess.current !== `${user.id}:${mode}`
    ) {
      form.setFieldValue('permissions', user.permissions);
      form.setFieldValue('fieldIds', currentFieldIds.data);
      initializedCurrentAccess.current = `${user.id}:${mode}`;
    }
  }, [currentFieldIds.data, form, users]);

  const isPending =
    capabilities.isPending ||
    fields.isPending ||
    subjects.isPending ||
    draftState.isPending ||
    (shouldLoadCurrentFields && currentFieldIds.isPending);
  const isError =
    capabilities.isError ||
    fields.isError ||
    subjects.isError ||
    draftState.isError ||
    (shouldLoadCurrentFields && currentFieldIds.isError);
  const immutableUsers = users.filter((user) => !user.canManage);
  const filteredFields = (fields.data ?? []).filter((field) => {
    const query = fieldSearch.trim().toLocaleLowerCase('ru');
    return (
      query === '' ||
      field.label.toLocaleLowerCase('ru').includes(query) ||
      field.id.toLocaleLowerCase('ru').includes(query)
    );
  });
  const visibleFields = filteredFields.slice(0, visibleFieldCount);

  return (
    <div className="page-content workflow-page">
      <WorkflowHeader
        title="Настройка доступа"
        description="Назначьте только те права и поля, которые доступны вам."
      />
      {subjectIds.length === 0 ? (
        <WorkflowState
          title="Сотрудник не выбран"
          description="Вернитесь к списку и выберите одного или нескольких сотрудников."
        />
      ) : isPending ? (
        <div aria-busy="true" className="skeleton workflow-skeleton" />
      ) : isError ? (
        <WorkflowState
          title="Настройки пока недоступны"
          description="Не удалось получить актуальные права, поля или карточки сотрудников. Ничего не было изменено."
          retry={() => {
            void capabilities.refetch();
            void fields.refetch();
            void subjects.refetch();
            void draftState.refetch();
          }}
        />
      ) : (subjects.data?.failedIds.length ?? 0) > 0 ? (
        <WorkflowState
          title="Часть сотрудников не загрузилась"
          description={`Загружено ${users.length} из ${subjectIds.length}. Настройка заблокирована, чтобы не применить неполный пакет.`}
          retry={() => void subjects.refetch()}
        />
      ) : !capabilities.data?.canManageAccess ? (
        <WorkflowState
          title="Нет права управлять доступом"
          description="Сервер не подтвердил право настройки доступа."
        />
      ) : immutableUsers.length > 0 ? (
        <WorkflowState
          title="Выбранный доступ нельзя изменить"
          description="Администраторы Bitrix24, ваша собственная учётная запись и неактивные сотрудники защищены от изменений в этом интерфейсе. Вернитесь к списку и измените выбор."
        />
      ) : (
        <form
          className="workflow-layout"
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <aside className="workflow-card subjects-card">
            <h2>Получатели</h2>
            <p>
              {users.length} {users.length === 1 ? 'сотрудник' : 'сотрудника'}
            </p>
            <ul>
              {users.map((user) => (
                <li key={user.id}>
                  <span className="avatar" aria-hidden="true">
                    {user.displayName
                      .split(' ')
                      .map((part) => part[0])
                      .slice(0, 2)
                      .join('')}
                  </span>
                  <span>
                    <strong>{user.displayName}</strong>
                    <small>
                      {user.department} · {user.permissionCount} прав
                    </small>
                  </span>
                </li>
              ))}
            </ul>
            <Link className="button-secondary" to="/access">
              Изменить выбор
            </Link>
          </aside>
          <div className="workflow-card settings-card">
            {(draftState.data ?? 0) > 0 && (
              <div className="inline-state" role="status">
                <Icons.info />
                <span>
                  Загружена версия черновика {draftState.data}. Если она изменится в другой вкладке,
                  сохранение этой формы будет безопасно отклонено.
                </span>
              </div>
            )}
            <div className="settings-section">
              <h2>Способ изменения</h2>
              <p>
                Сервер применит выбранный режим только к управляемой части доступа и повторно
                проверит версии настроек.
              </p>
              <form.Field name="mode">
                {(field) => (
                  <div className="choice-grid mode-grid">
                    {availableModes.includes('grant') && (
                      <label>
                        <input
                          checked={field.state.value === 'grant'}
                          name="access-mode"
                          onChange={() => {
                            field.handleChange('grant');
                            form.setFieldValue('permissions', ['app_access']);
                            form.setFieldValue('fieldIds', []);
                          }}
                          type="radio"
                        />
                        <span>
                          <strong>Добавить доступ</strong>
                          <small>Сохранить текущие права и добавить выбранные</small>
                        </span>
                      </label>
                    )}
                    {availableModes.includes('replace_managed') && (
                      <label>
                        <input
                          checked={field.state.value === 'replace_managed'}
                          name="access-mode"
                          onChange={() => {
                            initializedCurrentAccess.current = '';
                            field.handleChange('replace_managed');
                            if (users.length === 1 && users[0] && currentFieldIds.data) {
                              form.setFieldValue('permissions', users[0].permissions);
                              form.setFieldValue('fieldIds', currentFieldIds.data);
                            }
                          }}
                          type="radio"
                        />
                        <span>
                          <strong>Заменить настройки</strong>
                          <small>
                            Текущие права и поля загружены; снимите только то, что нужно отозвать
                          </small>
                        </span>
                      </label>
                    )}
                    {availableModes.includes('revoke_managed') && (
                      <label>
                        <input
                          checked={field.state.value === 'revoke_managed'}
                          name="access-mode"
                          onChange={() => {
                            field.handleChange('revoke_managed');
                            form.setFieldValue('permissions', []);
                            form.setFieldValue('fieldIds', []);
                          }}
                          type="radio"
                        />
                        <span>
                          <strong>Отозвать выбранное</strong>
                          <small>Отметьте ниже только права и поля, которые нужно удалить</small>
                        </span>
                      </label>
                    )}
                    {availableModes.includes('full_revoke') && (
                      <label className="choice-danger">
                        <input
                          checked={field.state.value === 'full_revoke'}
                          name="access-mode"
                          onChange={() => field.handleChange('full_revoke')}
                          type="radio"
                        />
                        <span>
                          <strong>Полностью отозвать доступ</strong>
                          <small>
                            {capabilities.data?.isAdmin
                              ? 'Будут удалены все настройки Task Commander'
                              : 'Доступно, только если весь доступ сотрудника находится в вашей зоне управления'}
                          </small>
                        </span>
                      </label>
                    )}
                    {availableModes.includes('repair') && (
                      <label>
                        <input
                          checked={field.state.value === 'repair'}
                          name="access-mode"
                          onChange={() => {
                            initializedCurrentAccess.current = '';
                            field.handleChange('repair');
                            if (users.length === 1 && users[0] && currentFieldIds.data) {
                              form.setFieldValue('permissions', users[0].permissions);
                              form.setFieldValue('fieldIds', currentFieldIds.data);
                            }
                          }}
                          type="radio"
                        />
                        <span>
                          <strong>Восстановить согласованность</strong>
                          <small>Только для настроек со статусом «Требует проверки»</small>
                        </span>
                      </label>
                    )}
                  </div>
                )}
              </form.Field>
            </div>
            <div className="settings-section">
              <h2>Права Task Commander</h2>
              <p>
                Недоступные вам права не отображаются. Право управления доступом может выдать
                руководителю только администратор.
              </p>
              <form.Field name="permissions">
                {(field) => (
                  <div className="choice-grid">
                    {permissionOptions
                      .filter(
                        ([id]) =>
                          capabilities.data?.permissions.includes(id) || id === 'app_access',
                      )
                      .map(([id, label]) => {
                        const disabled =
                          id === 'manage_access' &&
                          (!capabilities.data?.canGrantManageAccess ||
                            users.some((user) => !user.isManager));
                        const checked = field.state.value.includes(id);
                        return (
                          <label className={disabled ? 'choice-disabled' : ''} key={id}>
                            <input
                              checked={checked}
                              disabled={disabled || id === 'app_access'}
                              onChange={(event) =>
                                field.handleChange(
                                  event.target.checked
                                    ? [...field.state.value, id]
                                    : field.state.value.filter((value) => value !== id),
                                )
                              }
                              type="checkbox"
                            />
                            <span>
                              <strong>{label}</strong>
                              {id === 'app_access' && (
                                <small>Обязательное право для активного доступа</small>
                              )}
                              {disabled && (
                                <small>
                                  {capabilities.data?.canGrantManageAccess
                                    ? 'Получатель не является действующим руководителем'
                                    : 'Назначается только администратором'}
                                </small>
                              )}
                            </span>
                          </label>
                        );
                      })}
                  </div>
                )}
              </form.Field>
            </div>
            <div className="settings-section">
              <h2>Разрешённые поля задач</h2>
              <p>
                Task Commander не расширяет штатные права Bitrix24. Перед операцией доступ
                проверяется повторно.
              </p>
              <label className="search-field field-search">
                <span className="sr-only">Поиск поля задачи</span>
                <Icons.search />
                <input
                  onChange={(event) => {
                    setFieldSearch(event.target.value);
                    setVisibleFieldCount(100);
                  }}
                  placeholder="Название или код поля"
                  type="search"
                  value={fieldSearch}
                />
              </label>
              <form.Subscribe selector={(state) => state.values.mode}>
                {(mode) =>
                  users.length > 1 &&
                  mode === 'replace_managed' && (
                    <div className="inline-state">
                      <Icons.info />
                      <span>
                        У получателей могут быть разные текущие наборы. Здесь задаётся единый
                        итоговый набор; различия будут показаны отдельно на проверке.
                      </span>
                    </div>
                  )
                }
              </form.Subscribe>
              <form.Field name="fieldIds">
                {(field) =>
                  fields.data?.length === 0 ? (
                    <div className="inline-state">
                      <Icons.info />
                      <span>Нет доступных для делегирования полей.</span>
                    </div>
                  ) : filteredFields.length === 0 ? (
                    <div className="inline-state">
                      <Icons.info />
                      <span>Поля по этому запросу не найдены.</span>
                    </div>
                  ) : (
                    <>
                      <div className="choice-grid fields-grid">
                        {visibleFields.map((item) => (
                          <label key={item.id}>
                            <input
                              checked={field.state.value.includes(item.id)}
                              onChange={(event) =>
                                field.handleChange(
                                  event.target.checked
                                    ? [...field.state.value, item.id]
                                    : field.state.value.filter((value) => value !== item.id),
                                )
                              }
                              type="checkbox"
                            />
                            <span>
                              <strong>{item.label}</strong>
                              {item.group && <small>{item.group}</small>}
                            </span>
                          </label>
                        ))}
                      </div>
                      {visibleFields.length < filteredFields.length && (
                        <Button
                          className="button-secondary fields-more"
                          onClick={() => setVisibleFieldCount((count) => count + 100)}
                          type="button"
                        >
                          Показать ещё 100
                        </Button>
                      )}
                    </>
                  )
                }
              </form.Field>
            </div>
            <form.Subscribe selector={(state) => state.values.mode}>
              {(mode) =>
                mode !== 'grant' && (
                  <div className="settings-section reason-section">
                    <h2>Причина изменения</h2>
                    <p>
                      {mode === 'replace_managed' || mode === 'repair'
                        ? 'Причина нужна, только если итоговая проверка обнаружит фактическое сокращение доступа.'
                        : 'Причина обязательна для отзыва доступа и будет сохранена в аудите.'}
                    </p>
                    <form.Field name="reasonCode">
                      {(field) => (
                        <label className="form-field">
                          Причина
                          <select
                            onBlur={field.handleBlur}
                            onChange={(event) => field.handleChange(event.target.value)}
                            value={field.state.value}
                          >
                            <option value="">
                              {mode === 'replace_managed' || mode === 'repair'
                                ? 'Не указана'
                                : 'Выберите причину'}
                            </option>
                            {reasonOptions.map(([value, label]) => (
                              <option key={value} value={value}>
                                {label}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                    </form.Field>
                    <form.Subscribe selector={(state) => state.values.reasonCode}>
                      {(reasonCode) =>
                        reasonCode === 'other' && (
                          <form.Field name="reasonComment">
                            {(field) => (
                              <label className="form-field">
                                Комментарий
                                <textarea
                                  maxLength={500}
                                  minLength={10}
                                  onBlur={field.handleBlur}
                                  onChange={(event) => field.handleChange(event.target.value)}
                                  placeholder="Не менее 10 символов"
                                  required
                                  value={field.state.value}
                                />
                              </label>
                            )}
                          </form.Field>
                        )
                      }
                    </form.Subscribe>
                  </div>
                )
              }
            </form.Subscribe>
            {capabilities.data?.degraded && (
              <div className="inline-state">
                <Icons.info />
                <span>
                  Bitrix24 отвечает нестабильно. Сервер выполнит полную проверку перед применением.
                </span>
              </div>
            )}
            {submitError && (
              <div className="inline-state inline-state-error" role="alert">
                <Icons.info />
                <span>{submitError}</span>
              </div>
            )}
            <footer className="workflow-actions">
              <Link className="button-secondary" to="/access">
                Отмена
              </Link>
              <Button className="button-primary" disabled={!canMutate || submitting} type="submit">
                {submitting ? 'Проверяем…' : 'Проверить настройки'}
              </Button>
            </footer>
          </div>
        </form>
      )}
    </div>
  );
}

export function AccessReviewPage({ preflightId }: { preflightId: string }) {
  const app = useAppAccess();
  const canMutate = app?.canMutate === true && app.accessManagement === 'allowed';
  const navigate = useNavigate({ from: '/access/review' });
  const queryClient = useQueryClient();
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const commandId = useMemo(() => {
    if (!preflightId) return crypto.randomUUID();
    const key = `task-commander:access-command:${preflightId}`;
    const existing = sessionStorage.getItem(key);
    if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
    const created = crypto.randomUUID();
    sessionStorage.setItem(key, created);
    return created;
  }, [preflightId]);
  const preflight = useQuery({
    queryKey: ['access-management', 'preflight', preflightId],
    queryFn: () => fetchPreflight(preflightId),
    enabled: Boolean(preflightId),
    retry: 1,
  });
  const command = useMutation({
    mutationFn: async () => {
      if (!preflight.data) throw new Error('Проверка не загружена.');
      if (preflight.data.confirmation.required && !acknowledged) {
        throw new Error('Подтвердите, что вы проверили получателей и сокращения доступа.');
      }
      // A response can be lost after the server accepted the command. Recover that exact receipt
      // before minting a new confirmation identity for the same stable command ID.
      try {
        return await fetchCommand(commandId);
      } catch (error) {
        if (!(error instanceof AccessApiError) || error.status !== 404) throw error;
      }
      const confirmation = await confirmPreflight(preflight.data);
      return createCommand({
        commandId,
        preflightId,
        confirmationId: confirmation?.id,
        confirmationToken: confirmation?.token,
      });
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['app'] });
      notifyAccessInvalidated();
      await navigate({
        to: '/access/commands/$commandId',
        params: { commandId: result.commandId },
      });
    },
  });
  const targets = preflight.data?.targets ?? [];
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const preflightExpired = preflight.data
    ? new Date(preflight.data.expiresAt).getTime() <= clock
    : false;
  const warnings = targets.flatMap((target) =>
    target.issues.map((issue) => ({
      key: `${target.employee.userId}:${issue.code}`,
      employee: target.employee.displayName,
      message: issue.message,
    })),
  );
  const subjectSearch = { subjects: targets.map((target) => target.employee.userId).join(',') };
  return (
    <div className="page-content workflow-page">
      <WorkflowHeader
        title="Проверка изменений"
        description="Серверная проверка прав и получателей перед применением."
      />
      {!preflightId ? (
        <WorkflowState
          title="Проверка не найдена"
          description="Откройте этот этап из актуального черновика настроек."
        />
      ) : preflight.isPending ? (
        <div aria-busy="true" className="skeleton workflow-skeleton" />
      ) : preflight.isError ? (
        <WorkflowState
          title="Проверка недоступна"
          description="Срок проверки мог истечь, либо сервер временно недоступен. Вернитесь к настройке и выполните новую проверку."
          retry={() => void preflight.refetch()}
        />
      ) : (
        <section className="workflow-card review-card">
          <div className="review-summary">
            <span>
              <strong>{preflight.data.summary.ready}</strong>
              <small>готово к применению</small>
            </span>
            <span>
              <strong>{preflight.data.summary.excluded + preflight.data.summary.conflicts}</strong>
              <small>исключено или изменилось</small>
            </span>
            <span>
              <strong>{preflight.data.summary.noChange}</strong>
              <small>без изменений</small>
            </span>
            <span>
              <strong>{warnings.length}</strong>
              <small>предупреждений</small>
            </span>
          </div>
          <h2>Изменения по сотрудникам</h2>
          <p>
            Показаны только безопасные сводные данные: права и количество полей. Перед применением
            сервер ещё раз проверит версии и полномочия.
          </p>
          <ul className="review-targets">
            {targets.map((target) => {
              const requested = target.requestedDelta;
              const automatic = target.automaticDelta;
              return (
                <li key={target.employee.userId}>
                  <div>
                    <strong>{target.employee.displayName}</strong>
                    <small>
                      {target.employee.departmentName ?? 'Без подразделения'} ·{' '}
                      {preflightStateLabels[target.state]}
                    </small>
                  </div>
                  <p>
                    Запрошено: +{requested.permissions.added.length}/−
                    {requested.permissions.removed.length} прав, +{requested.fields.addedCount}/−
                    {requested.fields.removedCount} полей
                  </p>
                  {(automatic.permissions.added.length > 0 ||
                    automatic.permissions.removed.length > 0 ||
                    automatic.fields.addedCount > 0 ||
                    automatic.fields.removedCount > 0) && (
                    <p className="automatic-delta">
                      Автоматически по зависимостям: +{automatic.permissions.added.length}/−
                      {automatic.permissions.removed.length} прав, +{automatic.fields.addedCount}/−
                      {automatic.fields.removedCount} полей
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
          {warnings.length > 0 && (
            <div className="warning-list">
              <h3>Проверьте предупреждения</h3>
              <ul>
                {warnings.map((warning) => (
                  <li key={warning.key}>
                    <strong>{warning.employee}:</strong> {warning.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {preflightExpired && (
            <div className="inline-state inline-state-error" role="alert">
              <Icons.info />
              <span>
                Срок этой проверки истёк. Создайте новую проверку — старая команда не будет принята
                сервером.
              </span>
            </div>
          )}
          {command.error && (
            <div className="inline-state inline-state-error" role="alert">
              <Icons.info />
              <span>
                {accessErrorMessage(command.error, 'Не удалось получить результат команды.')} Если
                запрос мог быть отправлен, проверьте{' '}
                <Link params={{ commandId }} to="/access/commands/$commandId">
                  статус этой же команды
                </Link>{' '}
                — не запускайте новую.
              </span>
            </div>
          )}
          <footer className="workflow-actions">
            <Link className="button-secondary" search={subjectSearch} to="/access/configure">
              Создать новую проверку
            </Link>
            <Button
              className="button-primary"
              disabled={
                !canMutate ||
                command.isPending ||
                preflightExpired ||
                preflight.data.summary.ready === 0
              }
              onClick={() =>
                preflight.data.confirmation.required ? setConfirmationOpen(true) : command.mutate()
              }
            >
              {command.isPending
                ? 'Запускаем…'
                : preflight.data.confirmation.required
                  ? 'Перейти к подтверждению'
                  : 'Применить доступ'}
            </Button>
          </footer>
          <Modal
            className="confirmation-dialog"
            description={`Проверка действует 5 минут после подтверждения. Команда применит изменения только к ${preflight.data.summary.ready} готовым получателям.`}
            onClose={() => setConfirmationOpen(false)}
            open={confirmationOpen}
            title="Подтвердите изменение доступа"
          >
            <div className="confirmation-permissions">
              <h3>Права в готовых изменениях</h3>
              <ul>
                {targets
                  .filter((target) => target.state === 'ready')
                  .map((target) => (
                    <li key={target.employee.userId}>
                      <strong>{target.employee.displayName}</strong>
                      <span>
                        Запрошено: +{permissionListLabel(target.requestedDelta.permissions.added)};
                        −{permissionListLabel(target.requestedDelta.permissions.removed)}
                      </span>
                      <span>
                        Автоматически: +
                        {permissionListLabel(target.automaticDelta.permissions.added)}; −
                        {permissionListLabel(target.automaticDelta.permissions.removed)}
                      </span>
                      <span>
                        Поля: +{target.requestedDelta.fields.addedCount}/−
                        {target.requestedDelta.fields.removedCount}
                      </span>
                    </li>
                  ))}
              </ul>
            </div>
            {command.error && (
              <div className="inline-state inline-state-error" role="alert">
                <Icons.info />
                <span>
                  {accessErrorMessage(command.error, 'Не удалось получить результат команды.')}{' '}
                  Используйте тот же идентификатор команды для безопасного повтора.
                </span>
              </div>
            )}
            <label className="confirmation-check">
              <input
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
                type="checkbox"
              />
              <span>
                <strong>Подтверждаю проверку изменений</strong>
                <small>{preflight.data.confirmation.acknowledgementText}</small>
              </span>
            </label>
            <div className="dialog-actions">
              <Button className="button-secondary" onClick={() => setConfirmationOpen(false)}>
                Вернуться
              </Button>
              <Button
                className="button-primary"
                disabled={!canMutate || !acknowledged || command.isPending}
                onClick={() => {
                  if (canMutate) command.mutate();
                }}
              >
                {command.isPending ? 'Запускаем…' : 'Подтвердить и применить'}
              </Button>
            </div>
          </Modal>
        </section>
      )}
    </div>
  );
}

export function AccessCommandPage({ commandId }: { commandId: string }) {
  const command = useQuery({
    queryKey: ['access-management', 'command', commandId],
    queryFn: () => fetchCommand(commandId),
    refetchInterval: (query) =>
      ['accepted', 'validating', 'in_progress'].includes(query.state.data?.state ?? '')
        ? 2_000
        : false,
    retry: 2,
  });
  const terminal = command.data
    ? ['succeeded', 'partially_succeeded', 'failed', 'no_change'].includes(command.data.state)
    : false;
  const successful = command.data?.state === 'succeeded' || command.data?.state === 'no_change';
  const completed = command.data
    ? command.data.summary.applied +
      command.data.summary.failed +
      command.data.summary.noChange +
      command.data.summary.conflicts +
      command.data.summary.excluded
    : 0;
  const percent = command.data?.summary.total
    ? Math.round((completed / command.data.summary.total) * 100)
    : 0;
  const heading =
    command.data?.state === 'failed'
      ? 'Доступ не изменён'
      : command.data?.state === 'partially_succeeded'
        ? 'Доступ обновлён частично'
        : command.data?.state === 'no_change'
          ? 'Изменений не потребовалось'
          : successful
            ? 'Доступ обновлён'
            : 'Применение доступа';
  const retryTargets =
    command.data?.targets.filter(
      (target) => target.state === 'failed' || target.state === 'conflict',
    ) ?? [];
  return (
    <div className="page-content workflow-page">
      <WorkflowHeader
        title={heading}
        description={
          terminal
            ? 'Итог команды сохранён в журнале аудита.'
            : 'Команда продолжает выполняться на сервере, даже если закрыть эту страницу.'
        }
      />
      {command.isPending ? (
        <div aria-busy="true" className="skeleton workflow-skeleton" />
      ) : command.isError ? (
        <WorkflowState
          title="Статус команды недоступен"
          description="Не запускайте изменение повторно. Обновите статус этой же команды."
          retry={() => void command.refetch()}
        />
      ) : (
        <section aria-live="polite" className="workflow-card command-card">
          <span
            className={`command-icon ${successful ? 'command-success' : terminal ? 'command-warning' : ''}`}
          >
            {successful ? <Icons.check /> : terminal ? <Icons.info /> : <Icons.refresh />}
          </span>
          <h2>{heading}</h2>
          <p>
            {completed} из {command.data.summary.total} получателей обработано
          </p>
          <progress
            aria-label={`Выполнено ${percent}%`}
            className="progress"
            max={100}
            value={percent}
          />
          <dl className="command-summary">
            <div>
              <dt>Применено</dt>
              <dd>{command.data.summary.applied}</dd>
            </div>
            <div>
              <dt>Без изменений</dt>
              <dd>{command.data.summary.noChange}</dd>
            </div>
            <div>
              <dt>Конфликты</dt>
              <dd>{command.data.summary.conflicts}</dd>
            </div>
            <div>
              <dt>Исключено</dt>
              <dd>{command.data.summary.excluded}</dd>
            </div>
            <div>
              <dt>Ошибки</dt>
              <dd>{command.data.summary.failed}</dd>
            </div>
          </dl>
          {command.data.targets.some(
            (target) =>
              target.state === 'failed' ||
              target.state === 'conflict' ||
              target.state === 'excluded',
          ) && (
            <div className="command-issues">
              <h3>Требуют внимания</h3>
              <ul>
                {command.data.targets
                  .filter(
                    (target) =>
                      target.state === 'failed' ||
                      target.state === 'conflict' ||
                      target.state === 'excluded',
                  )
                  .map((target) => (
                    <li key={target.userId}>
                      <strong>{target.displayName}</strong>
                      <span>
                        {target.state === 'conflict'
                          ? 'Настройки изменились после проверки'
                          : target.state === 'excluded'
                            ? 'Исключён безопасной проверкой'
                            : 'Изменение не применено'}
                        {target.reasonCode
                          ? ` · ${targetReasonLabels[target.reasonCode] ?? 'требуется повторная проверка'}`
                          : ''}
                      </span>
                    </li>
                  ))}
              </ul>
            </div>
          )}
          {command.data.targets.some((target) => target.notificationState === 'failed') && (
            <div className="inline-state inline-state-error">
              <Icons.info />
              <span>
                Для части сотрудников изменение применено, но уведомление не отправлено. Это не
                откатывает доступ; сбой сохранён в аудите.
              </span>
            </div>
          )}
          <footer className="workflow-actions">
            <Link className="button-secondary" to="/access">
              К сотрудникам
            </Link>
            {retryTargets.length > 0 && (
              <Link
                className="button-secondary"
                search={{ subjects: retryTargets.map((target) => target.userId).join(',') }}
                to="/access/configure"
              >
                Проверить проблемных заново
              </Link>
            )}
            {terminal && (
              <Link className="button-primary" to="/audit">
                Открыть аудит
              </Link>
            )}
          </footer>
        </section>
      )}
    </div>
  );
}

export function AccessAdminRepairPage() {
  const capabilities = useQuery({
    queryKey: ['access-management', 'capabilities'],
    queryFn: fetchCapabilities,
  });
  const reviewUsers = useQuery({
    queryKey: ['access-management', 'repair-candidates'],
    queryFn: async () => {
      const result: AccessUser[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const page = await fetchUsers({ q: '', status: 'all', cursor });
        result.push(
          ...page.items.filter((user) => user.status === 'review' || user.status === 'quarantined'),
        );
        if (page.nextCursor && seenCursors.has(page.nextCursor)) {
          throw new Error('Сервер повторил страницу списка сотрудников.');
        }
        if (page.nextCursor) seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
      } while (cursor);
      return result;
    },
    enabled: capabilities.data?.isAdmin === true,
  });
  return (
    <div className="page-content workflow-page">
      <WorkflowHeader
        title="Проверка настроек доступа"
        description="Служебный маршрут восстановления доступен только администратору Bitrix24."
      />
      {capabilities.isPending ? (
        <div aria-busy="true" className="skeleton workflow-skeleton" />
      ) : capabilities.isError ? (
        <WorkflowState
          title="Нельзя подтвердить полномочия"
          description="Служебные действия заблокированы до безопасной проверки сессии."
        />
      ) : !capabilities.data.isAdmin ? (
        <WorkflowState
          title="Требуются права администратора"
          description="Раздел не раскрывает сведения о настройках и не доступен назначенным руководителям."
        />
      ) : reviewUsers.isPending ? (
        <div aria-busy="true" className="skeleton workflow-skeleton" />
      ) : reviewUsers.isError ? (
        <WorkflowState
          title="Список для проверки недоступен"
          description="Ничего не было изменено. Повторите загрузку актуальных данных Bitrix24."
          retry={() => void reviewUsers.refetch()}
        />
      ) : (
        <section className="workflow-card repair-card">
          <span className="state-icon">
            <Icons.refresh />
          </span>
          <h2>Повторная синхронизация Bitrix24</h2>
          <p>
            Восстановление доступно только для настроек со статусом «Требует проверки» или
            «Карантин». Оно не повышает права и не обходит серверную валидацию.
          </p>
          {reviewUsers.data.length === 0 ? (
            <div className="inline-state">
              <Icons.check />
              <span>Настроек, требующих восстановления, не найдено.</span>
            </div>
          ) : (
            <ul className="repair-candidates">
              {reviewUsers.data.map((user) => (
                <li key={user.id}>
                  <span>
                    <strong>{user.displayName}</strong>
                    <small>
                      {user.department} ·{' '}
                      {user.status === 'review' ? 'Требует проверки' : 'Карантин'}
                    </small>
                  </span>
                  <Link
                    className="button-secondary"
                    search={{ subjects: user.id }}
                    to="/access/configure"
                  >
                    Проверить
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <footer className="workflow-actions">
            <Link className="button-secondary" to="/access">
              Вернуться
            </Link>
          </footer>
        </section>
      )}
    </div>
  );
}
