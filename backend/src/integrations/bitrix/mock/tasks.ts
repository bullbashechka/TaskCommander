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
  TaskSelectAllResult,
} from '../contract';
import {
  taskApplyRequestSchema,
  taskReadForChangeRequestSchema,
  taskSearchRequestSchema,
  taskSelectAllRequestSchema,
} from '../schemas';
import type { MockTask } from './fixtures';
import type { MockScenarioController, MockScenarioEffect } from './scenario';
import type { MockPortalState } from './state';
import { createRelevantVersion } from './version';

const baseFieldCapabilities: readonly Omit<
  TaskFieldCapability,
  'filterLabel' | 'isFilterable' | 'isSortable' | 'filterValueSource' | 'filterOptions'
>[] = [
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
    id: 'UF_TASK_EFFORT',
    sourceType: 'double',
    kind: 'number',
    isMultiple: false,
    isNullable: true,
    isEditable: true,
    isSupported: true,
  },
  {
    id: 'UF_TASK_APPROVED',
    sourceType: 'boolean',
    kind: 'boolean',
    isMultiple: false,
    isNullable: false,
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

const fieldLabels: Readonly<Record<string, string>> = {
  title: 'Название',
  description: 'Описание',
  creator_id: 'Постановщик',
  responsible_id: 'Исполнитель',
  accomplice_ids: 'Соисполнители',
  auditor_ids: 'Наблюдатели',
  deadline: 'Крайний срок',
  start_date: 'Дата начала',
  priority: 'Приоритет',
  status: 'Статус',
  group_id: 'Проект',
  tags: 'Теги',
  UF_TASK_EFFORT: 'Трудозатраты',
  UF_TASK_APPROVED: 'Согласовано',
  crm_binding: 'Связь с CRM',
};

const fieldOptions: Readonly<Record<string, readonly { value: string; label: string }[]>> = {
  priority: [
    { value: 'normal', label: 'Обычный' },
    { value: 'high', label: 'Высокий' },
  ],
  status: [
    { value: 'pending', label: 'Ждёт выполнения' },
    { value: 'in_progress', label: 'Выполняется' },
    { value: 'pending_review', label: 'Ждёт контроля' },
    { value: 'deferred', label: 'Отложена' },
  ],
};

function filterValueSource(
  capability: (typeof baseFieldCapabilities)[number],
): TaskFieldCapability['filterValueSource'] {
  if (!capability.isSupported || capability.kind === null) return null;
  if (fieldOptions[capability.id]) return 'options';
  if (capability.kind === 'user') return 'users';
  if (capability.kind === 'number') return 'number';
  if (capability.kind === 'date_time') return 'date_time';
  if (capability.kind === 'boolean') return 'boolean';
  return 'text';
}

const fieldCapabilities: readonly TaskFieldCapability[] = baseFieldCapabilities.map(
  (capability) => ({
    ...capability,
    filterLabel: fieldLabels[capability.id] ?? capability.id,
    isFilterable: capability.isSupported && capability.kind !== null,
    isSortable: capability.isSupported && capability.kind !== null,
    filterValueSource: filterValueSource(capability),
    filterOptions: [...(fieldOptions[capability.id] ?? [])],
  }),
);

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
  if (filter.operator === 'between') {
    return (
      timestamp >= (values[0] ?? Number.NEGATIVE_INFINITY) &&
      timestamp <= (values[1] ?? Number.POSITIVE_INFINITY)
    );
  }
  return false;
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
  const capability = fieldCapabilities.find((field) => field.id === filter.fieldId);
  const isMultiple = capability?.isMultiple ?? Array.isArray(value);
  const collectionsEqual =
    actual.length === expected.length &&
    actual.every((item) => expected.includes(item)) &&
    expected.every((item) => actual.includes(item));
  if (filter.operator === 'equals') {
    if (!isMultiple) return actual.length === 1 && expected.includes(actual[0] ?? '');
    return collectionsEqual;
  }

  if (!isMultiple) return actual.length !== 1 || !expected.includes(actual[0] ?? '');
  return !collectionsEqual;
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
  fieldId: string,
): number {
  if (left === null || right === null) return 0;

  const capability = fieldCapabilities.find((field) => field.id === fieldId);
  if (capability?.kind === 'date_time' && typeof left === 'string' && typeof right === 'string') {
    return Date.parse(left) - Date.parse(right);
  }

  if (typeof left === 'number' && typeof right === 'number') return left - right;

  const leftValue = Array.isArray(left) ? left.join('\u0000') : String(left);
  const rightValue = Array.isArray(right) ? right.join('\u0000') : String(right);
  return leftValue.localeCompare(rightValue, 'ru', { numeric: true, sensitivity: 'base' });
}

function compareTaskIds(left: string, right: string): number {
  const leftId = BigInt(left);
  const rightId = BigInt(right);
  if (leftId < rightId) return -1;
  if (leftId > rightId) return 1;
  return 0;
}

function createTaskUrl(taskId: string, userId: string): string {
  return `https://portal.bitrix24.ru/company/personal/user/${userId}/tasks/task/view/${taskId}/`;
}

async function toSummary(
  task: MockTask,
  userId: string,
  responsibleName: string | null,
): Promise<TaskSearchPage['items'][number]> {
  if (task.status === 'completed') {
    throw new Error('Completed tasks cannot be returned as mutable task summaries.');
  }

  const taskUrl = createTaskUrl(task.id, userId);
  const values = Object.fromEntries(
    Object.entries(task.values).map(([fieldId, value]) => [fieldId, cloneValue(value)]),
  );
  const snapshotWithoutVersion = {
    taskId: task.id,
    title: task.title,
    taskUrl,
    status: task.status,
    values,
    editableFieldIds: getEditableFieldIds(task, userId, Object.keys(values)),
    deadlineManagedBySubtasks: task.deadlineManagedBySubtasks,
  };

  return {
    id: task.id,
    title: task.title,
    taskUrl,
    parentId: task.parentId,
    groupId: typeof task.values.group_id === 'string' ? task.values.group_id : null,
    status: task.status,
    responsibleId: String(getFieldValue(task, 'responsible_id')),
    responsibleName,
    deadline: typeof task.values.deadline === 'string' ? task.values.deadline : null,
    priority: task.values.priority === 'high' ? 'high' : 'normal',
    relevantVersion: await createRelevantVersion(snapshotWithoutVersion),
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
    taskUrl: createTaskUrl(task.id, state.currentUserId),
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
    const leftValue = getFieldValue(left, request.sort.fieldId);
    const rightValue = getFieldValue(right, request.sort.fieldId);
    if (leftValue === null || rightValue === null) {
      if (leftValue !== rightValue) return leftValue === null ? 1 : -1;
      return compareTaskIds(left.id, right.id);
    }

    const compared = compareValues(leftValue, rightValue, request.sort.fieldId);
    if (compared !== 0) {
      return request.sort.direction === 'asc' ? compared : -compared;
    }

    return compareTaskIds(left.id, right.id);
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
      const items = await Promise.all(
        matching
          .slice(start, start + request.pageSize)
          .map((task) => {
            const responsibleId = String(getFieldValue(task, 'responsible_id'));
            return toSummary(
              task,
              state.currentUserId,
              state.users.get(responsibleId)?.displayName ?? null,
            );
          }),
      );
      const page: TaskSearchPage = {
        items,
        total: matching.length,
        hasNextPage: start + request.pageSize < matching.length,
      };
      return { ok: true, value: page };
    },
    async selectAll(input) {
      const request = taskSelectAllRequestSchema.parse(input);
      const effects = scenario.take('tasks.selectAll');
      for (const effect of effects) applyTaskMutation(state, effect);
      const failure = getFailure(effects);
      if (failure) return { ok: false, failure };

      const matching = filterAndSortTasks(state, {
        ...request,
        page: 1,
        pageSize: 50,
      });
      const total = matching.length;
      const resolution: TaskSelectAllResult =
        total === 0
          ? { kind: 'empty', total: 0 }
          : total > 1_000
            ? { kind: 'too_many', total }
            : { kind: 'selected', taskIds: matching.map((task) => task.id), total };
      return { ok: true, value: resolution };
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
