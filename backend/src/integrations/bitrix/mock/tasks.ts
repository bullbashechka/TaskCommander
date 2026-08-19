import type { TaskFilter } from '@task-commander/contracts';

import type {
  BitrixFailure,
  BitrixResult,
  BitrixTasks,
  TaskApplyOutcome,
  TaskChangeSnapshot,
  TaskFieldCapability,
  TaskSearchPage,
  TaskSearchRequest,
} from '../contract';
import {
  taskApplyRequestSchema,
  taskReadForChangeRequestSchema,
  taskSearchRequestSchema,
} from '../schemas';
import type { MockTask } from './fixtures';
import type { MockScenarioController, MockScenarioEffect } from './scenario';
import type { MockPortalState } from './state';
import { createRelevantVersion } from './version';

const fieldCapabilities: readonly TaskFieldCapability[] = [
  {
    id: 'title',
    sourceType: 'string',
    kind: 'text',
    isMultiple: false,
    isNullable: false,
    isEditable: true,
    isSupported: true,
  },
  {
    id: 'description',
    sourceType: 'string',
    kind: 'text',
    isMultiple: false,
    isNullable: true,
    isEditable: true,
    isSupported: true,
  },
  {
    id: 'creator_id',
    sourceType: 'user',
    kind: 'user',
    isMultiple: false,
    isNullable: false,
    isEditable: true,
    isSupported: true,
  },
  {
    id: 'responsible_id',
    sourceType: 'user',
    kind: 'user',
    isMultiple: false,
    isNullable: false,
    isEditable: true,
    isSupported: true,
  },
  {
    id: 'accomplice_ids',
    sourceType: 'user',
    kind: 'user',
    isMultiple: true,
    isNullable: true,
    isEditable: true,
    isSupported: true,
  },
  {
    id: 'auditor_ids',
    sourceType: 'user',
    kind: 'user',
    isMultiple: true,
    isNullable: true,
    isEditable: true,
    isSupported: true,
  },
  {
    id: 'deadline',
    sourceType: 'datetime',
    kind: 'date_time',
    isMultiple: false,
    isNullable: true,
    isEditable: true,
    isSupported: true,
  },
  {
    id: 'start_date',
    sourceType: 'datetime',
    kind: 'date_time',
    isMultiple: false,
    isNullable: true,
    isEditable: true,
    isSupported: true,
  },
  {
    id: 'priority',
    sourceType: 'enum',
    kind: 'list',
    isMultiple: false,
    isNullable: false,
    isEditable: true,
    isSupported: true,
  },
  {
    id: 'status',
    sourceType: 'enum',
    kind: 'list',
    isMultiple: false,
    isNullable: false,
    isEditable: true,
    isSupported: true,
  },
  {
    id: 'group_id',
    sourceType: 'group',
    kind: 'list',
    isMultiple: false,
    isNullable: true,
    isEditable: true,
    isSupported: true,
  },
  {
    id: 'tags',
    sourceType: 'tag',
    kind: 'tags',
    isMultiple: true,
    isNullable: true,
    isEditable: true,
    isSupported: true,
  },
  {
    id: 'crm_binding',
    sourceType: 'crm',
    kind: null,
    isMultiple: true,
    isNullable: true,
    isEditable: true,
    isSupported: false,
  },
];

function isReadable(task: MockTask, userId: string): boolean {
  return task.readableBy.includes(userId);
}

function getFieldValue(
  task: MockTask,
  fieldId: string,
): string | number | boolean | null | string[] {
  if (fieldId === 'title') {
    return task.title;
  }

  if (fieldId === 'status') {
    return task.status;
  }

  return task.values[fieldId] ?? null;
}

function asStringValues(value: string | number | boolean | null | string[]): string[] {
  if (value === null) {
    return [];
  }

  if (Array.isArray(value)) {
    return value;
  }

  return [String(value)];
}

function isSet(value: string | number | boolean | null | string[]): boolean {
  return value !== null && (!Array.isArray(value) || value.length > 0) && value !== '';
}

function matchesText(
  value: string | number | boolean | null | string[],
  filter: TaskFilter,
): boolean {
  if (filter.kind !== 'text') {
    return false;
  }

  if (filter.operator === 'is_set') {
    return isSet(value);
  }

  if (filter.operator === 'is_not_set') {
    return !isSet(value);
  }

  const text = asStringValues(value).join(' ').toLocaleLowerCase('ru');
  const values = (filter.values ?? []).map((item) => item.toLocaleLowerCase('ru'));

  if (filter.operator === 'contains') {
    return values.some((item) => text.includes(item));
  }

  if (filter.operator === 'not_contains') {
    return values.every((item) => !text.includes(item));
  }

  if (filter.operator === 'equals') {
    return values.some((item) => text === item);
  }

  return values.every((item) => text !== item);
}

function matchesDate(
  value: string | number | boolean | null | string[],
  filter: TaskFilter,
): boolean {
  if (filter.kind !== 'date_time') {
    return false;
  }

  if (filter.operator === 'is_set') {
    return isSet(value);
  }

  if (filter.operator === 'is_not_set') {
    return !isSet(value);
  }

  if (typeof value !== 'string') {
    return false;
  }

  const timestamp = Date.parse(value);
  const values = (filter.values ?? []).map((item) => Date.parse(item));
  if (filter.operator === 'equals') return values.includes(timestamp);
  if (filter.operator === 'before') return timestamp < (values[0] ?? Number.NEGATIVE_INFINITY);
  if (filter.operator === 'after') return timestamp > (values[0] ?? Number.POSITIVE_INFINITY);
  return (
    timestamp >= (values[0] ?? Number.NEGATIVE_INFINITY) &&
    timestamp <= (values[1] ?? Number.POSITIVE_INFINITY)
  );
}

function matchesNumber(
  value: string | number | boolean | null | string[],
  filter: TaskFilter,
): boolean {
  if (filter.kind !== 'number') {
    return false;
  }

  if (filter.operator === 'is_set') return isSet(value);
  if (filter.operator === 'is_not_set') return !isSet(value);
  if (typeof value !== 'number') return false;

  const values = filter.values ?? [];
  if (filter.operator === 'equals') return values.includes(value);
  if (filter.operator === 'not_equals') return values.every((item) => item !== value);
  if (filter.operator === 'greater_than') return value > (values[0] ?? Number.POSITIVE_INFINITY);
  if (filter.operator === 'less_than') return value < (values[0] ?? Number.NEGATIVE_INFINITY);
  return (
    value >= (values[0] ?? Number.NEGATIVE_INFINITY) &&
    value <= (values[1] ?? Number.POSITIVE_INFINITY)
  );
}

function matchesCollection(
  value: string | number | boolean | null | string[],
  filter: TaskFilter,
): boolean {
  if (filter.kind !== 'list' && filter.kind !== 'tags' && filter.kind !== 'user') {
    return false;
  }

  if (filter.operator === 'is_set') return isSet(value);
  if (filter.operator === 'is_not_set') return !isSet(value);

  const actual = asStringValues(value);
  const expected = filter.values ?? [];
  if (filter.operator === 'includes') return expected.some((item) => actual.includes(item));
  if (filter.operator === 'not_includes') return expected.every((item) => !actual.includes(item));
  if (filter.operator === 'equals') {
    return actual.length === expected.length && actual.every((item) => expected.includes(item));
  }

  return !(actual.length === expected.length && actual.every((item) => expected.includes(item)));
}

function matchesBoolean(
  value: string | number | boolean | null | string[],
  filter: TaskFilter,
): boolean {
  return filter.kind === 'boolean' && typeof value === 'boolean' && value === filter.values[0];
}

function matchesFilter(task: MockTask, filter: TaskFilter): boolean {
  const value = getFieldValue(task, filter.fieldId);
  switch (filter.kind) {
    case 'text':
      return matchesText(value, filter);
    case 'date_time':
      return matchesDate(value, filter);
    case 'number':
      return matchesNumber(value, filter);
    case 'list':
    case 'tags':
    case 'user':
      return matchesCollection(value, filter);
    case 'boolean':
      return matchesBoolean(value, filter);
  }
}

function compareValues(
  left: string | number | boolean | null | string[],
  right: string | number | boolean | null | string[],
): number {
  if (left === null || right === null) {
    if (left === right) return 0;
    return left === null ? 1 : -1;
  }

  const leftValue = Array.isArray(left) ? left.join('\u0000') : String(left);
  const rightValue = Array.isArray(right) ? right.join('\u0000') : String(right);
  return leftValue.localeCompare(rightValue, 'ru', { numeric: true, sensitivity: 'base' });
}

function toSummary(task: MockTask): TaskSearchPage['items'][number] {
  if (task.status === 'completed') {
    throw new Error('Completed tasks cannot be returned as mutable task summaries.');
  }

  return {
    id: task.id,
    title: task.title,
    taskUrl: `https://portal.bitrix24.ru/company/personal/user/1/tasks/task/view/${task.id}/`,
    parentId: task.parentId,
    status: task.status,
    responsibleId: String(getFieldValue(task, 'responsible_id')),
    deadline: typeof task.values.deadline === 'string' ? task.values.deadline : null,
    priority: task.values.priority === 'high' ? 'high' : 'normal',
  };
}

function getEditableFieldIds(
  task: MockTask,
  userId: string,
  fieldIds: readonly string[],
): string[] {
  const editable = task.editableFieldIdsByUser[userId] ?? [];
  return fieldIds.filter((fieldId) => editable.includes(fieldId));
}

function cloneValue(
  value: string | number | boolean | null | string[],
): string | number | boolean | null | string[] {
  return Array.isArray(value) ? [...value] : value;
}

function valuesEqual(
  left: string | number | boolean | null | string[],
  right: string | number | boolean | null | string[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function applyTaskMutation(state: MockPortalState, effect: MockScenarioEffect): void {
  if (effect.kind !== 'mutate_task') {
    return;
  }

  const task = state.getMutableTask(effect.taskId);
  if (!task) {
    return;
  }

  if (effect.patch.status !== undefined) {
    task.status = effect.patch.status;
    task.values.status = effect.patch.status;
  }

  if (effect.patch.values !== undefined) {
    for (const [fieldId, value] of Object.entries(effect.patch.values)) {
      task.values[fieldId] = cloneValue(value);
      if (fieldId === 'title' && typeof value === 'string') {
        task.title = value;
      }
    }
  }
}

function getFailure(effects: readonly MockScenarioEffect[]): BitrixFailure | null {
  const effect = effects.find((candidate) => candidate.kind === 'return_failure');
  return effect?.kind === 'return_failure' ? effect.failure : null;
}

async function createChangeSnapshot(
  state: MockPortalState,
  taskId: string,
  fieldIds: readonly string[],
): Promise<BitrixResult<TaskChangeSnapshot>> {
  const task = state.getTask(taskId);
  if (!task || task.deleted || !isReadable(task, state.currentUserId)) {
    return { ok: false, failure: { kind: 'not_found_or_forbidden' } };
  }

  const values = Object.fromEntries(
    fieldIds.map((fieldId) => [fieldId, cloneValue(getFieldValue(task, fieldId))]),
  );
  const snapshotWithoutVersion = {
    taskId: task.id,
    title: task.title,
    taskUrl: `https://portal.bitrix24.ru/company/personal/user/1/tasks/task/view/${task.id}/`,
    status: task.status,
    values,
    editableFieldIds: getEditableFieldIds(task, state.currentUserId, fieldIds),
    deadlineManagedBySubtasks: task.deadlineManagedBySubtasks,
  };

  return {
    ok: true,
    value: {
      ...snapshotWithoutVersion,
      relevantVersion: await createRelevantVersion(snapshotWithoutVersion),
    },
  };
}

function setTaskValue(
  task: MockTask,
  fieldId: string,
  value: string | number | boolean | null | string[],
): void {
  task.values[fieldId] = cloneValue(value);
  if (fieldId === 'title' && typeof value === 'string') {
    task.title = value;
  }
  if (fieldId === 'status' && typeof value === 'string') {
    task.status = value as MockTask['status'];
  }
}

function filterAndSortTasks(state: MockPortalState, request: TaskSearchRequest): MockTask[] {
  const seenTaskIds = new Set<string>();
  const matching: MockTask[] = [];

  for (const taskId of state.getCandidateTaskIds()) {
    if (seenTaskIds.has(taskId)) {
      continue;
    }
    seenTaskIds.add(taskId);

    const task = state.getTask(taskId);
    if (
      !task ||
      task.deleted ||
      task.status === 'completed' ||
      task.isTemplate ||
      task.isRecurrenceRule ||
      !isReadable(task, state.currentUserId) ||
      !request.filters.every((filter) => matchesFilter(task, filter))
    ) {
      continue;
    }

    matching.push(task);
  }

  matching.sort((left, right) => {
    const compared = compareValues(
      getFieldValue(left, request.sort.fieldId),
      getFieldValue(right, request.sort.fieldId),
    );
    if (compared !== 0) {
      return request.sort.direction === 'asc' ? compared : -compared;
    }

    return Number(left.id) - Number(right.id);
  });

  return matching;
}

export function createMockTasks(
  state: MockPortalState,
  scenario: MockScenarioController = { take: () => [] },
): BitrixTasks {
  return {
    async getFieldCapabilities() {
      return { ok: true, value: fieldCapabilities };
    },
    async search(input) {
      const effects = scenario.take('tasks.search');
      for (const effect of effects) applyTaskMutation(state, effect);
      const failure = getFailure(effects);
      if (failure) return { ok: false, failure };

      const request = taskSearchRequestSchema.parse(input);
      const matching = filterAndSortTasks(state, request);
      const start = (request.page - 1) * request.pageSize;
      const items = matching.slice(start, start + request.pageSize).map(toSummary);
      const page: TaskSearchPage = {
        items,
        total: matching.length,
        hasNextPage: start + request.pageSize < matching.length,
      };
      return { ok: true, value: page };
    },
    async readForChange(input) {
      const request = taskReadForChangeRequestSchema.parse(input);
      const effects = scenario.take('tasks.readForChange', request.taskId);
      for (const effect of effects) applyTaskMutation(state, effect);
      const failure = getFailure(effects);
      if (failure) return { ok: false, failure };
      return createChangeSnapshot(state, request.taskId, request.fieldIds);
    },
    async applyChange(input) {
      const request = taskApplyRequestSchema.parse(input);
      const effects = scenario.take('tasks.applyChange', request.taskId);
      for (const effect of effects) applyTaskMutation(state, effect);
      const failure = getFailure(effects);
      if (failure) return { ok: false, failure };

      const fieldIds = Object.keys(request.targetValues);
      const current = await createChangeSnapshot(state, request.taskId, fieldIds);
      if (!current.ok) return current;
      if (current.value.relevantVersion !== request.expectedRelevantVersion) {
        return { ok: true, value: { kind: 'conflict', reason: 'state_changed' } };
      }
      if (current.value.status === 'completed') {
        return { ok: true, value: { kind: 'conflict', reason: 'state_changed' } };
      }
      if (!fieldIds.every((fieldId) => current.value.editableFieldIds.includes(fieldId))) {
        return { ok: false, failure: { kind: 'permission_denied' } };
      }
      if (current.value.deadlineManagedBySubtasks && fieldIds.includes('deadline')) {
        return {
          ok: false,
          failure: {
            kind: 'permanent_failure',
            reasonCode: 'deadline_managed_by_subtasks',
            fieldIds: ['deadline'],
          },
        };
      }

      const task = state.getMutableTask(request.taskId);
      if (!task) return { ok: false, failure: { kind: 'not_found_or_forbidden' } };
      const changedFieldIds = fieldIds.filter(
        (fieldId) =>
          !valuesEqual(getFieldValue(task, fieldId), request.targetValues[fieldId] ?? null),
      );
      if (changedFieldIds.length === 0) return { ok: true, value: { kind: 'no_change' } };

      const droppedResponse = effects.find(
        (effect): effect is Extract<MockScenarioEffect, { kind: 'apply_then_drop_response' }> =>
          effect.kind === 'apply_then_drop_response',
      );
      const appliedFieldIds = droppedResponse
        ? changedFieldIds.filter((fieldId) => droppedResponse.appliedFieldIds.includes(fieldId))
        : changedFieldIds;
      for (const fieldId of appliedFieldIds) {
        const value = request.targetValues[fieldId];
        if (value !== undefined) setTaskValue(task, fieldId, value);
      }

      if (!droppedResponse) {
        const outcome: TaskApplyOutcome = { kind: 'success', appliedFieldIds };
        return { ok: true, value: outcome };
      }

      const reconciled = state.getTask(request.taskId);
      if (!reconciled) {
        return {
          ok: false,
          failure: { kind: 'temporary_failure', reasonCode: 'write_response_lost' },
        };
      }
      const reconciledApplied = changedFieldIds.filter((fieldId) =>
        valuesEqual(getFieldValue(reconciled, fieldId), request.targetValues[fieldId] ?? null),
      );
      if (reconciledApplied.length === changedFieldIds.length) {
        return { ok: true, value: { kind: 'success', appliedFieldIds: reconciledApplied } };
      }
      if (reconciledApplied.length === 0) {
        return {
          ok: false,
          failure: { kind: 'temporary_failure', reasonCode: 'write_response_lost' },
        };
      }
      return {
        ok: true,
        value: {
          kind: 'partially_applied',
          appliedFieldIds: reconciledApplied,
          failedFieldIds: changedFieldIds.filter((fieldId) => !reconciledApplied.includes(fieldId)),
        },
      };
    },
  };
}
