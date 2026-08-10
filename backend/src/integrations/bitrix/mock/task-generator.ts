import type { MockTask } from './fixtures';

const generatedTaskStartId = 1_000;

export function getGeneratedTaskId(index: number): string {
  return String(generatedTaskStartId + index);
}

export function isGeneratedTaskId(id: string, taskCount: number): boolean {
  const numericId = Number(id);
  return (
    Number.isInteger(numericId) &&
    numericId >= generatedTaskStartId &&
    numericId < generatedTaskStartId + taskCount
  );
}

export function createGeneratedTask(index: number): MockTask {
  const id = getGeneratedTaskId(index);
  const day = (index % 28) + 1;
  const responsibleId = String((index % 5) + 10);
  const status = index % 7 === 0 ? 'pending' : 'in_progress';
  const priority = index % 10 === 0 ? 'high' : 'normal';
  const title = `Generated task ${id}`;

  return {
    id,
    title,
    parentId: index % 23 === 0 ? String(generatedTaskStartId + Math.max(0, index - 1)) : null,
    status,
    isTemplate: false,
    isRecurrenceRule: false,
    isRecurringInstance: index % 29 === 0,
    deleted: false,
    readableBy: ['1', '10'],
    editableFieldIdsByUser: {
      '1': [
        'title',
        'description',
        'creator_id',
        'responsible_id',
        'accomplice_ids',
        'auditor_ids',
        'deadline',
        'start_date',
        'priority',
        'status',
        'group_id',
        'tags',
      ],
      '10': [
        'title',
        'description',
        'responsible_id',
        'accomplice_ids',
        'auditor_ids',
        'deadline',
        'start_date',
        'priority',
        'status',
        'group_id',
        'tags',
      ],
    },
    deadlineManagedBySubtasks: false,
    values: {
      title,
      description: `Generated description ${id}`,
      creator_id: '1',
      responsible_id: responsibleId,
      accomplice_ids: [],
      auditor_ids: [],
      deadline: `2026-09-${String(day).padStart(2, '0')}T10:00:00+05:00`,
      start_date: `2026-09-${String(Math.max(1, day - 2)).padStart(2, '0')}T10:00:00+05:00`,
      priority,
      status,
      group_id: String((index % 4) + 1),
      tags: [`tag-${index % 8}`],
    },
  };
}
