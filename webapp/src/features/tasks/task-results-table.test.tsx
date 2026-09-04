import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { TaskSearchItem } from '@task-commander/contracts';

import { TaskResultsTable } from './task-results-table';

const tasks: TaskSearchItem[] = [
  {
    id: '42',
    title: 'Первая задача',
    taskUrl: 'https://portal.bitrix24.ru/tasks/42',
    parentId: null,
    groupId: '1',
    status: 'in_progress',
    responsibleId: '10',
    responsibleName: 'Иван Петров',
    deadline: '2020-01-01T00:00:00Z',
    priority: 'high',
    relevantVersion: 'v42',
  },
  {
    id: '43',
    title: 'Вторая задача с длинным названием',
    taskUrl: 'https://portal.bitrix24.ru/tasks/43',
    parentId: '42',
    groupId: null,
    status: 'pending_review',
    responsibleId: '11',
    responsibleName: null,
    deadline: null,
    priority: 'normal',
    relevantVersion: 'v43',
  },
];

describe('task results table', () => {
  it('uses stable IDs and exposes a mixed page selection', () => {
    const togglePage = vi.fn();
    const toggleTask = vi.fn();
    render(
      <TaskResultsTable
        items={tasks}
        onTogglePage={togglePage}
        onToggleTask={toggleTask}
        selectedIds={new Set(['42'])}
        selectionDisabled={false}
      />,
    );

    const pageCheckbox = screen.getByRole('checkbox', {
      name: 'Выбрать все задачи на странице',
    }) as HTMLInputElement;
    expect(pageCheckbox.indeterminate).toBe(true);
    expect(screen.getByRole('row', { name: /Первая задача/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByText('Просрочено')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Открыть задачу: Первая задача' }),
    ).toHaveAttribute('target', '_blank');

    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'Выбрать задачу: Вторая задача с длинным названием',
      }),
    );
    expect(toggleTask).toHaveBeenCalledWith('43', true);
    fireEvent.click(pageCheckbox);
    expect(togglePage).toHaveBeenCalledWith(['42', '43'], true);
  });

  it('blocks another task and page selection at the 1,000-task limit', () => {
    const selectedIds = new Set(
      Array.from({ length: 1000 }, (_, index) => String(10_000 + index)),
    );
    render(
      <TaskResultsTable
        items={tasks}
        onTogglePage={vi.fn()}
        onToggleTask={vi.fn()}
        selectedIds={selectedIds}
        selectionDisabled={false}
      />,
    );

    expect(
      screen.getByRole('checkbox', { name: 'Выбрать все задачи на странице' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('checkbox', { name: 'Выбрать задачу: Первая задача' }),
    ).toBeDisabled();
  });

  it(
    'blocks an over-limit page selection without disabling individual rows below the limit',
    () => {
      const selectedIds = new Set(
        Array.from({ length: 999 }, (_, index) => String(10_000 + index)),
      );
      render(
        <TaskResultsTable
          items={tasks}
          onTogglePage={vi.fn()}
          onToggleTask={vi.fn()}
          selectedIds={selectedIds}
          selectionDisabled={false}
        />,
      );

      expect(
        screen.getByRole('checkbox', { name: 'Выбрать все задачи на странице' }),
      ).toBeDisabled();
      expect(
        screen.getByRole('checkbox', { name: 'Выбрать задачу: Первая задача' }),
      ).toBeEnabled();
    },
  );
});
