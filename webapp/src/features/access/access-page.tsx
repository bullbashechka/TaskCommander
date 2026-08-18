import { Button } from '@base-ui/react/button';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type RowSelectionState,
} from '@tanstack/react-table';
import {
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';

import { Icons } from '@/components/ui/icons';
import { Modal } from '@/components/ui/modal';

import {
  AccessApiError,
  createDepartmentSnapshot,
  fetchCapabilities,
  fetchDepartments,
  fetchUsers,
} from './access-api';
import type { AccessStatus, AccessUser } from './access-types';

type StatusFilter = 'all' | 'active' | 'none';

const statusLabels: Record<AccessStatus, string> = {
  active: 'Активен',
  quarantined: 'Карантин',
  none: 'Нет доступа',
  review: 'Требует проверки',
};

function isSafeAvatarUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

function Initials({ user }: { user: AccessUser }) {
  const [imageFailed, setImageFailed] = useState(false);
  const initials = user.displayName
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('');
  if (!imageFailed && isSafeAvatarUrl(user.avatarUrl)) {
    return (
      <img
        alt=""
        className="avatar"
        onError={() => setImageFailed(true)}
        referrerPolicy="no-referrer"
        src={user.avatarUrl}
      />
    );
  }
  return (
    <span aria-hidden="true" className="avatar">
      {initials}
    </span>
  );
}

function formatCheckTime(value: string | null) {
  if (!value) return 'время проверки неизвестно';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'время проверки неизвестно';
  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60_000));
  return minutes === 0 ? 'только что' : `${minutes} мин. назад`;
}

function PageState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <section className="access-state" role="status">
      <span className="state-icon">
        <Icons.info />
      </span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </section>
  );
}

function LoadingPage() {
  return (
    <div aria-busy="true" aria-label="Загрузка управления доступом" className="access-loading">
      <div className="skeleton skeleton-hero" />
      <div className="access-grid">
        <div className="skeleton skeleton-table" />
        <div className="skeleton skeleton-rail" />
      </div>
    </div>
  );
}

function EmployeeTable({
  users,
  selected,
  onSelectedChange,
}: {
  users: AccessUser[];
  selected: RowSelectionState;
  onSelectedChange: Dispatch<SetStateAction<RowSelectionState>>;
}) {
  const columns = useMemo<Array<ColumnDef<AccessUser>>>(
    () => [
      {
        id: 'select',
        header: ({ table }) => (
          <input
            aria-label="Выбрать всех сотрудников на странице"
            checked={table.getIsAllPageRowsSelected()}
            className="table-checkbox"
            onChange={table.getToggleAllPageRowsSelectedHandler()}
            ref={(node) => {
              if (node) node.indeterminate = table.getIsSomePageRowsSelected();
            }}
            type="checkbox"
          />
        ),
        cell: ({ row }) => (
          <input
            aria-label={`Выбрать: ${row.original.displayName}`}
            checked={row.getIsSelected()}
            className="table-checkbox"
            disabled={!row.original.canManage}
            onChange={row.getToggleSelectedHandler()}
            type="checkbox"
          />
        ),
      },
      {
        id: 'employee',
        header: 'Сотрудник',
        cell: ({ row }) => (
          <div className="employee-cell">
            <Initials user={row.original} />
            <span>
              <strong>{row.original.displayName}</strong>
              <small>{row.original.position}</small>
            </span>
          </div>
        ),
      },
      { accessorKey: 'department', header: 'Подразделение' },
      {
        id: 'status',
        header: 'Доступ',
        cell: ({ row }) => (
          <span className={`access-status access-status-${row.original.status}`}>
            <i aria-hidden="true" />
            {statusLabels[row.original.status]}
          </span>
        ),
      },
      {
        id: 'rights',
        header: 'Права',
        cell: ({ row }) =>
          row.original.isBitrixAdmin ? (
            <span className="admin-label">Администратор</span>
          ) : row.original.permissionCount > 0 ? (
            `${row.original.permissionCount} прав`
          ) : (
            '—'
          ),
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Действия</span>,
        cell: ({ row }) =>
          row.original.canManage ? (
            <Link
              aria-label={`Настроить доступ: ${row.original.displayName}`}
              className="table-action"
              search={{ subjects: row.original.id }}
              to="/access/configure"
            >
              <Icons.more />
            </Link>
          ) : (
            <button
              aria-label={
                row.original.isBitrixAdmin
                  ? 'Доступ администратора Bitrix24 неизменяем'
                  : row.original.isSelf
                    ? 'Нельзя изменить собственный доступ'
                    : row.original.status === 'quarantined' || row.original.status === 'review'
                      ? 'Настройки доступны только в административном восстановлении'
                      : 'Неактивного сотрудника нельзя настроить'
              }
              className="table-action table-action-disabled"
              disabled
              type="button"
            >
              <Icons.more />
            </button>
          ),
      },
    ],
    [],
  );

  const table = useReactTable({
    columns,
    data: users,
    enableRowSelection: (row) => row.original.canManage,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
    onRowSelectionChange: onSelectedChange,
    state: { rowSelection: selected },
  });

  return (
    <div className="employee-table-wrap">
      <table className="employee-table">
        <thead>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {group.headers.map((header) => (
                <th key={header.id}>
                  {header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr className={row.getIsSelected() ? 'row-selected' : ''} key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AttentionRail({ users, isAdmin }: { users: AccessUser[]; isAdmin: boolean }) {
  const attention = users.filter((user) => user.attentionReason || user.status === 'review');
  return (
    <aside aria-labelledby="attention-title" className="attention-rail">
      <section className="rail-card">
        <header>
          <h2 id="attention-title">Внимание на странице</h2>
          <span>{attention.length}</span>
        </header>
        {attention.length === 0 ? (
          <div className="rail-empty">
            <Icons.check />
            <p>Нет настроек, требующих проверки</p>
          </div>
        ) : (
          <ul>
            {attention.slice(0, 4).map((user) => (
              <li key={user.id}>
                <Initials user={user} />
                <span>
                  <strong>{user.displayName}</strong>
                  <small>{user.attentionReason ?? 'Настройки требуют проверки'}</small>
                </span>
                {user.canManage ? (
                  <Link
                    aria-label={`Открыть: ${user.displayName}`}
                    search={{ subjects: user.id }}
                    to="/access/configure"
                  >
                    <Icons.arrow />
                  </Link>
                ) : (
                  <span className="rail-action-disabled" aria-label="Изменение недоступно">
                    <Icons.arrow />
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {isAdmin ? (
          <Link className="button-secondary rail-all" to="/access/admin-repair">
            Открыть восстановление
          </Link>
        ) : (
          <p className="rail-page-note">Показаны сотрудники текущей страницы</p>
        )}
      </section>
      <section className="access-help">
        <span>
          <Icons.info />
        </span>
        <div>
          <h2>Как работает доступ</h2>
          <p>Назначенные права дополнительно проверяются в Bitrix24 для каждой задачи.</p>
          <a href="#access-rules">Подробнее</a>
        </div>
      </section>
    </aside>
  );
}

function DepartmentPicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate({ from: '/access' });
  const [departmentId, setDepartmentId] = useState('');
  const departments = useQuery({
    queryKey: ['access-management', 'departments'],
    queryFn: fetchDepartments,
    enabled: open,
  });
  const snapshot = useMutation({
    mutationFn: () => createDepartmentSnapshot(departmentId),
    onSuccess: async (result) => {
      if (result.excludedCount > 0) return;
      if (result.subjectIds.length === 0) return;
      await navigate({
        to: '/access/configure',
        search: { subjects: result.subjectIds.join(',') },
      });
    },
  });
  if (!open) return null;
  return (
    <Modal
      description="Состав будет зафиксирован сервером перед настройкой доступа."
      onClose={onClose}
      open={open}
      title="Добавить подразделение"
    >
      {departments.isPending ? (
        <div aria-busy="true" className="skeleton dialog-skeleton" />
      ) : departments.isError ? (
        <div className="inline-state inline-state-error" role="alert">
          <Icons.info />
          <span>Не удалось получить подразделения.</span>
        </div>
      ) : departments.data.length === 0 ? (
        <div className="inline-state">
          <Icons.info />
          <span>Доступные подразделения не найдены.</span>
        </div>
      ) : (
        <label className="dialog-field">
          Подразделение
          <select onChange={(event) => setDepartmentId(event.target.value)} value={departmentId}>
            <option value="">Выберите подразделение</option>
            {departments.data.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {snapshot.isSuccess && snapshot.data.subjectIds.length === 0 && (
        <div className="inline-state inline-state-error" role="alert">
          <Icons.info />
          <span>В подразделении нет доступных для настройки сотрудников.</span>
        </div>
      )}
      {snapshot.isSuccess && snapshot.data.excludedCount > 0 && (
        <div className="inline-state" role="status">
          <Icons.info />
          <span>
            Будут выбраны {snapshot.data.subjectIds.length} сотрудников. Ещё{' '}
            {snapshot.data.excludedCount} исключены: это ваша учётная запись, администраторы
            Bitrix24 или неактивные сотрудники.
          </span>
        </div>
      )}
      {snapshot.isError && (
        <div className="inline-state inline-state-error" role="alert">
          <Icons.info />
          <span>{snapshot.error.message}</span>
        </div>
      )}
      <footer className="dialog-actions">
        <Button className="button-secondary" onClick={onClose}>
          Отмена
        </Button>
        {snapshot.isSuccess && snapshot.data.excludedCount > 0 ? (
          <Button
            className="button-primary"
            disabled={snapshot.data.subjectIds.length === 0}
            onClick={() =>
              void navigate({
                to: '/access/configure',
                search: { subjects: snapshot.data.subjectIds.join(',') },
              })
            }
          >
            Продолжить без исключённых
          </Button>
        ) : (
          <Button
            className="button-primary"
            disabled={!departmentId || snapshot.isPending}
            onClick={() => snapshot.mutate()}
          >
            {snapshot.isPending ? 'Фиксируем состав…' : 'Продолжить'}
          </Button>
        )}
      </footer>
    </Modal>
  );
}

export function AccessPage() {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [selected, setSelected] = useState<RowSelectionState>({});
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [departmentPickerOpen, setDepartmentPickerOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const capabilities = useQuery({
    queryKey: ['access-management', 'capabilities'],
    queryFn: fetchCapabilities,
    retry: 1,
  });
  const users = useQuery({
    queryKey: ['access-management', 'users', query, status, cursor],
    queryFn: () => fetchUsers({ q: query, status, cursor }),
    placeholderData: keepPreviousData,
    retry: 1,
  });

  if (capabilities.isPending || users.isPending)
    return (
      <div className="page-content">
        <LoadingPage />
      </div>
    );
  if (capabilities.error instanceof AccessApiError && capabilities.error.status === 403) {
    return (
      <div className="page-content">
        <PageState
          title="Нет доступа к управлению"
          description="Раздел доступен администраторам Bitrix24 и руководителям с отдельным правом управления доступом."
        />
      </div>
    );
  }
  if (capabilities.isError) {
    return (
      <div className="page-content">
        <PageState
          title="Управление доступом временно недоступно"
          description={`Не удалось безопасно проверить ваши полномочия.${capabilities.error instanceof AccessApiError && capabilities.error.eventId ? ` Код события: ${capabilities.error.eventId}.` : ''}`}
          action={
            <Button className="button-secondary" onClick={() => void capabilities.refetch()}>
              Повторить
            </Button>
          }
        />
      </div>
    );
  }
  if (!capabilities.data.canManageAccess) {
    return (
      <div className="page-content">
        <PageState
          title="Нет права управлять доступом"
          description="Ваши текущие права позволяют пользоваться Task Commander, но не назначать доступ другим сотрудникам."
        />
      </div>
    );
  }

  const list = (users.data?.items ?? []).map((user) =>
    user.id === capabilities.data.actorUserId ? { ...user, isSelf: true, canManage: false } : user,
  );
  const selectedIds = Object.entries(selected)
    .filter(([, value]) => value)
    .map(([id]) => id);
  const activeCount = list.filter((user) => user.status === 'active').length;
  const noAccessCount = list.filter((user) => user.status === 'none').length;
  const reviewCount = list.filter(
    (user) => user.attentionReason || user.status === 'review' || user.status === 'quarantined',
  ).length;
  const configureSearch = { subjects: selectedIds.join(',') };

  return (
    <div
      className={`page-content access-page ${selectedIds.length > 0 ? 'access-page-has-bulk' : ''}`}
    >
      <nav aria-label="Хлебные крошки" className="breadcrumbs">
        <span>Система</span>
        <i>/</i>
        <strong>Доступ</strong>
      </nav>

      <section className="access-hero">
        <div className="hero-copy">
          <h1>Управление доступом</h1>
          <p>Права сотрудников Task Commander — в одном рабочем пространстве.</p>
          <div className="bitrix-check">
            <Icons.refresh />
            <span>
              Данные Bitrix24 проверены {formatCheckTime(capabilities.data.bitrixCheckedAt)}
            </span>
            {capabilities.data.degraded && <b>Частичная проверка</b>}
          </div>
          <dl aria-label="Статистика текущей страницы" className="access-stats">
            <div>
              <dt>На странице · с доступом</dt>
              <dd>{activeCount}</dd>
            </div>
            <div>
              <dt>На странице · без доступа</dt>
              <dd>{noAccessCount}</dd>
            </div>
            <div>
              <dt>На странице · требует проверки</dt>
              <dd>{reviewCount}</dd>
            </div>
          </dl>
        </div>
        <aside className="new-access-card">
          <h2>Новый доступ</h2>
          <p>Сотруднику или подразделению</p>
          <Button className="button-primary" onClick={() => searchRef.current?.focus()}>
            Настроить
          </Button>
          <button
            className="button-link"
            onClick={() => setDepartmentPickerOpen(true)}
            type="button"
          >
            Добавить подразделение
          </button>
        </aside>
      </section>

      {capabilities.data.degraded && (
        <div className="degraded-banner" role="status">
          <Icons.info />
          <span>
            <strong>Данные Bitrix24 обновлены частично.</strong> Настройки можно просматривать, но
            сохранение будет повторно проверено сервером.
          </span>
        </div>
      )}

      <div className="access-grid">
        <section aria-labelledby="employees-title" className="employees-panel">
          <header className="employees-toolbar">
            <h2 id="employees-title">
              Сотрудники на странице <span>{list.length}</span>
            </h2>
            <label className="search-field">
              <span className="sr-only">Поиск сотрудников</span>
              <Icons.search />
              <input
                onChange={(event) => {
                  setQuery(event.target.value);
                  setCursor(null);
                  setCursorHistory([]);
                  setSelected({});
                }}
                placeholder="Имя, должность или отдел"
                ref={searchRef}
                type="search"
                value={query}
              />
            </label>
          </header>
          <div aria-label="Фильтр по доступу" className="access-tabs" role="group">
            {(
              [
                ['all', 'Все'],
                ['active', 'С доступом'],
                ['none', 'Без доступа'],
              ] as const
            ).map(([value, label]) => (
              <button
                aria-pressed={status === value}
                key={value}
                onClick={() => {
                  setStatus(value);
                  setCursor(null);
                  setCursorHistory([]);
                  setSelected({});
                }}
                type="button"
              >
                {label}
              </button>
            ))}
          </div>

          {users.isError ? (
            <div className="inline-state" role="alert">
              <Icons.info />
              <span>
                <strong>Список сотрудников не обновлён.</strong> Остальная часть раздела доступна.
              </span>
              <Button className="button-secondary" onClick={() => void users.refetch()}>
                Повторить
              </Button>
            </div>
          ) : (
            <>
              {list.length === 0 ? (
                <PageState
                  title="На этой странице совпадений нет"
                  description={
                    users.data?.nextCursor
                      ? 'Продолжите поиск на следующей странице Bitrix24.'
                      : query
                        ? 'Измените поисковый запрос или сбросьте фильтры.'
                        : 'Bitrix24 не вернул сотрудников для выбранного фильтра.'
                  }
                  action={
                    query && !users.data?.nextCursor ? (
                      <Button className="button-secondary" onClick={() => setQuery('')}>
                        Очистить поиск
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <EmployeeTable onSelectedChange={setSelected} selected={selected} users={list} />
              )}
              <footer className="table-pagination">
                <span>Показано на странице: {list.length}</span>
                <span>До 50 сотрудников из текущей страницы Bitrix24</span>
                <div>
                  <button
                    aria-label="Предыдущая страница"
                    disabled={cursorHistory.length === 0}
                    onClick={() => {
                      const previous = cursorHistory.at(-1) ?? '';
                      setCursorHistory((history) => history.slice(0, -1));
                      setCursor(previous || null);
                      setSelected({});
                    }}
                    type="button"
                  >
                    ‹
                  </button>
                  <button aria-current="page" type="button">
                    {cursorHistory.length + 1}
                  </button>
                  <button
                    aria-label="Следующая страница"
                    disabled={!users.data?.nextCursor}
                    onClick={() => {
                      if (!users.data?.nextCursor) return;
                      setCursorHistory((history) => [...history, cursor ?? '']);
                      setCursor(users.data.nextCursor);
                      setSelected({});
                    }}
                    type="button"
                  >
                    ›
                  </button>
                </div>
              </footer>
            </>
          )}
        </section>
        <AttentionRail isAdmin={capabilities.data.isAdmin} users={list} />
      </div>

      {selectedIds.length > 0 && (
        <div aria-live="polite" className="bulk-action-bar">
          <strong>Выбрано: {selectedIds.length}</strong>
          <button className="button-link" onClick={() => setSelected({})} type="button">
            Очистить
          </button>
          <Link className="button-primary" search={configureSearch} to="/access/configure">
            Настроить доступ для {selectedIds.length}{' '}
            {selectedIds.length === 1 ? 'сотрудника' : 'сотрудников'}
          </Link>
        </div>
      )}
      <span id="access-rules" />
      <DepartmentPicker
        onClose={() => setDepartmentPickerOpen(false)}
        open={departmentPickerOpen}
      />
    </div>
  );
}
