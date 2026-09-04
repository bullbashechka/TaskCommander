import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type RowSelectionState,
} from '@tanstack/react-table';
import { useMemo } from 'react';

import type { TaskSearchItem } from '@task-commander/contracts';

const statusLabels: Readonly<Record<TaskSearchItem['status'], string>> = {
  pending: 'Ждёт выполнения',
  in_progress: 'Выполняется',
  pending_review: 'Ждёт контроля',
  deferred: 'Отложена',
};

function formatDeadline(value: string | null): string {
  if (!value) return 'Не задан';
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}

export function TaskResultsTable({
  items,
  selectedIds,
  selectionDisabled,
  onTogglePage,
  onToggleTask,
}: {
  items: TaskSearchItem[];
  selectedIds: ReadonlySet<string>;
  selectionDisabled: boolean;
  onTogglePage: (taskIds: string[], selected: boolean) => void;
  onToggleTask: (taskId: string, selected: boolean) => void;
}) {
  const rowSelection = useMemo<RowSelectionState>(
    () => Object.fromEntries([...selectedIds].map((taskId) => [taskId, true])),
    [selectedIds],
  );
  const columns = useMemo<Array<ColumnDef<TaskSearchItem>>>(
    () => [
      {
        id: 'select',
        header: ({ table }) => {
          const pageIds = table.getRowModel().rows.map((row) => row.id);
          const selectedOnPage = pageIds.filter((taskId) => selectedIds.has(taskId)).length;
          const allSelected = pageIds.length > 0 && selectedOnPage === pageIds.length;
          const someSelected = selectedOnPage > 0 && !allSelected;
          const wouldExceedLimit =
            selectedIds.size + pageIds.filter((taskId) => !selectedIds.has(taskId)).length > 1000;
          return (
            <input
              aria-label="Выбрать все задачи на странице"
              checked={allSelected}
              className="table-checkbox"
              disabled={
                selectionDisabled || pageIds.length === 0 || (!allSelected && wouldExceedLimit)
              }
              onChange={(event) => onTogglePage(pageIds, event.target.checked)}
              ref={(node) => {
                if (node) node.indeterminate = someSelected;
              }}
              type="checkbox"
            />
          );
        },
        cell: ({ row }) => {
          const selected = selectedIds.has(row.id);
          return (
            <input
              aria-label={`Выбрать задачу: ${row.original.title}`}
              checked={selected}
              className="table-checkbox"
              disabled={selectionDisabled || (!selected && selectedIds.size >= 1000)}
              onChange={(event) => onToggleTask(row.id, event.target.checked)}
              type="checkbox"
            />
          );
        },
      },
      {
        id: 'task',
        header: 'Задача',
        cell: ({ row }) => (
          <div className="task-name-cell">
            <a
              href={row.original.taskUrl}
              rel="noreferrer"
              target="_blank"
              title={row.original.title}
            >
              {row.original.title}
            </a>
            <small>#{row.original.id}</small>
          </div>
        ),
      },
      {
        id: 'responsible',
        header: 'Исполнитель',
        cell: ({ row }) => (
          <span>{row.original.responsibleName ?? `Сотрудник #${row.original.responsibleId}`}</span>
        ),
      },
      {
        accessorKey: 'status',
        header: 'Статус',
        cell: ({ row }) => (
          <span className={`task-status task-status-${row.original.status}`}>
            {statusLabels[row.original.status]}
          </span>
        ),
      },
      {
        accessorKey: 'priority',
        header: 'Приоритет',
        cell: ({ row }) => (
          <span className={`task-priority task-priority-${row.original.priority}`}>
            {row.original.priority === 'high' ? 'Высокий' : 'Обычный'}
          </span>
        ),
      },
      {
        accessorKey: 'deadline',
        header: 'Крайний срок',
        cell: ({ row }) => {
          const overdue =
            row.original.deadline !== null && Date.parse(row.original.deadline) < Date.now();
          return (
            <span className={overdue ? 'task-deadline task-deadline-overdue' : 'task-deadline'}>
              {formatDeadline(row.original.deadline)}
              {overdue ? <small>Просрочено</small> : null}
            </span>
          );
        },
      },
      {
        accessorKey: 'groupId',
        header: 'Проект',
        cell: ({ row }) => (row.original.groupId ? `Проект #${row.original.groupId}` : '—'),
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Действия</span>,
        cell: ({ row }) => (
          <a
            aria-label={`Открыть задачу: ${row.original.title}`}
            className="task-row-action"
            href={row.original.taskUrl}
            rel="noreferrer"
            target="_blank"
          >
            Открыть
          </a>
        ),
      },
    ],
    [onTogglePage, onToggleTask, selectedIds, selectionDisabled],
  );
  const table = useReactTable({
    columns,
    data: items,
    enableRowSelection: true,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
    state: { rowSelection },
  });

  return (
    <div className="task-results-table-wrap">
      <table className="task-results-table">
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
            <tr
              aria-selected={selectedIds.has(row.id)}
              className={selectedIds.has(row.id) ? 'task-row-selected' : undefined}
              key={row.id}
            >
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
