import { z } from 'zod';

import {
  preflightPreviewSchema,
  bulkChangeCommandSchema,
  type BulkChangeCommand,
  type BulkOperationDraft,
  type PreflightPreview,
  type PreflightTaskEntry,
  type TaskChangeCatalogResponse,
  type TaskChangeValue,
  type RetryTaskIntent,
} from '@task-commander/contracts';

import type { BitrixAdapter, TaskChangeSnapshot } from '../integrations/bitrix/contract';
import {
  bitrixAccessStatusSchema,
  bitrixProjectAccessStatusSchema,
  portalCalendarSchema,
  taskChangeSnapshotSchema,
} from '../integrations/bitrix/schemas';
import { isUrlFromOrigins } from '../runtime/origin-policy';
import {
  calculateTaskChanges,
  TaskChangeCalculationError,
  type TaskChangeCalculation,
} from './calculation';
import { InvalidTaskChangeDefinitionError, requireValidBulkChanges } from './catalog';

const taskReadConcurrency = 8;
const directoryConcurrency = 4;
const directoryBatchSize = 50;
const maximumCalendarExceptions = 1000;
const preflightApplicationByteLimit = 7_000_000;
const textEncoder = new TextEncoder();
const accessStatusListSchema = z.array(bitrixAccessStatusSchema).max(directoryBatchSize);
const projectAccessStatusListSchema = z
  .array(bitrixProjectAccessStatusSchema)
  .max(directoryBatchSize);

export type TaskPreflightErrorCode =
  'UNAUTHENTICATED' | 'RATE_LIMITED' | 'UPSTREAM_UNAVAILABLE' | 'PREFLIGHT_TOO_LARGE';

export class TaskPreflightError extends Error {
  constructor(readonly code: TaskPreflightErrorCode) {
    super(code);
    this.name = 'TaskPreflightError';
  }
}

export interface BuildTaskPreflightInput {
  adapter: BitrixAdapter;
  draft: BulkOperationDraft;
  catalog: TaskChangeCatalogResponse;
  actorAccessVersion: number | null;
  trustedPortalOrigins: readonly string[];
  now?: () => Date;
}

function absoluteRetryCommands(
  intent: RetryTaskIntent,
  catalog: TaskChangeCatalogResponse,
): BulkChangeCommand[] {
  const fields = new Map(catalog.fields.map((field) => [field.id, field]));
  const commands = Object.entries(intent.targetValues).map(([fieldId, value]) => {
    const field = fields.get(fieldId);
    if (!field) throw new Error('Retry field is no longer available.');
    const candidate: unknown =
      value === null || (Array.isArray(value) && value.length === 0)
        ? { fieldId, kind: field.kind, action: 'clear' }
        : Array.isArray(value)
          ? { fieldId, kind: field.kind, action: 'replace', values: value }
          : { fieldId, kind: field.kind, action: 'set', value };
    return bulkChangeCommandSchema.parse(candidate);
  });
  requireValidBulkChanges(commands, catalog);
  return commands;
}

type PreliminaryResult =
  | { kind: 'entry'; entry: PreflightTaskEntry }
  | {
      kind: 'calculated';
      snapshot: TaskChangeSnapshot;
      calculation: TaskChangeCalculation;
    };

function globalFailure(code: TaskPreflightErrorCode): never {
  throw new TaskPreflightError(code);
}

function jsonByteSize(value: unknown): number {
  if (value === null) return 4;
  if (typeof value === 'string') return textEncoder.encode(JSON.stringify(value)).byteLength;
  if (typeof value === 'number') return String(value).length;
  if (typeof value === 'boolean') return value ? 4 : 5;
  if (Array.isArray(value)) {
    return (
      2 + value.reduce((size, item) => size + jsonByteSize(item), 0) + Math.max(0, value.length - 1)
    );
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    return (
      2 +
      entries.reduce(
        (size, [key, item]) =>
          size + textEncoder.encode(JSON.stringify(key)).byteLength + 1 + jsonByteSize(item),
        0,
      ) +
      Math.max(0, entries.length - 1)
    );
  }
  return Number.POSITIVE_INFINITY;
}

function byteBudget(limit: number) {
  let consumed = 0;
  return (value: unknown) => {
    consumed += jsonByteSize(value);
    if (consumed > limit) globalFailure('PREFLIGHT_TOO_LARGE');
  };
}

function excludedEntry(input: {
  taskId: string;
  title?: string | null;
  taskUrl?: string | null;
  reasonCode: string;
  reasonMessage: string;
  relevantVersion?: string | null;
  currentValues?: Record<string, TaskChangeValue> | null;
  targetValues?: Record<string, TaskChangeValue> | null;
}): PreflightTaskEntry {
  return {
    taskId: input.taskId,
    title: input.title ?? null,
    taskUrl: input.taskUrl ?? null,
    disposition: 'excluded_by_preflight',
    changedFieldIds: [],
    reasonCode: input.reasonCode,
    reasonMessage: input.reasonMessage,
    relevantVersion: input.relevantVersion ?? null,
    currentValues: input.currentValues ?? null,
    targetValues: input.targetValues ?? null,
  };
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item !== undefined) results[index] = await operation(item, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function mapTaskReadFailure(taskId: string, failure: { kind: string }): PreliminaryResult {
  switch (failure.kind) {
    case 'not_authenticated':
      return globalFailure('UNAUTHENTICATED');
    case 'rate_limited':
      return globalFailure('RATE_LIMITED');
    case 'temporary_failure':
    case 'invalid_external_response':
    case 'unsupported_capability':
      return globalFailure('UPSTREAM_UNAVAILABLE');
    case 'permission_denied':
    case 'not_found_or_forbidden':
      return {
        kind: 'entry',
        entry: excludedEntry({
          taskId,
          reasonCode: 'TASK_UNAVAILABLE',
          reasonMessage: 'Задача недоступна или не существует.',
        }),
      };
    case 'permanent_failure':
      return {
        kind: 'entry',
        entry: excludedEntry({
          taskId,
          reasonCode: 'TASK_CHECK_FAILED',
          reasonMessage: 'Задачу не удалось проверить из-за ограничения Битрикс24.',
        }),
      };
    default:
      return globalFailure('UPSTREAM_UNAVAILABLE');
  }
}

async function readTask(
  adapter: BitrixAdapter,
  taskId: string,
  fieldIds: string[],
  trustedPortalOrigins: readonly string[],
  consumeBytes: (value: unknown) => void,
): Promise<PreliminaryResult | { kind: 'snapshot'; snapshot: TaskChangeSnapshot }> {
  let result: Awaited<ReturnType<BitrixAdapter['tasks']['readForChange']>>;
  try {
    result = await adapter.tasks.readForChange({ taskId, fieldIds });
  } catch {
    return globalFailure('UPSTREAM_UNAVAILABLE');
  }
  if (!result.ok) return mapTaskReadFailure(taskId, result.failure);
  consumeBytes(result.value);
  const parsed = taskChangeSnapshotSchema.safeParse(result.value);
  if (
    !parsed.success ||
    parsed.data.taskId !== taskId ||
    (fieldIds.includes('status') && parsed.data.values.status !== parsed.data.status) ||
    (parsed.data.taskUrl !== null && !isUrlFromOrigins(parsed.data.taskUrl, trustedPortalOrigins))
  ) {
    return globalFailure('UPSTREAM_UNAVAILABLE');
  }
  return { kind: 'snapshot', snapshot: parsed.data };
}

function calendarPadding(commands: readonly BulkChangeCommand[]): number {
  const shifts = commands.filter(
    (command): command is Extract<BulkChangeCommand, { action: 'shift' }> =>
      command.action === 'shift',
  );
  const calendarDays = Math.max(
    0,
    ...shifts
      .filter((command) => command.calendar === 'calendar_days')
      .map((command) => command.days),
  );
  const workingDays = Math.max(
    0,
    ...shifts
      .filter((command) => command.calendar === 'working_days')
      .map((command) => command.days),
  );
  const worstCalendarDays = Math.max(calendarDays, (workingDays + maximumCalendarExceptions) * 7);
  return Math.ceil(worstCalendarDays / 365) + 2;
}

async function loadCalendar(
  adapter: BitrixAdapter,
  commands: readonly BulkChangeCommand[],
  snapshots: readonly TaskChangeSnapshot[],
) {
  const shiftFields = new Set(
    commands.filter((command) => command.action === 'shift').map((command) => command.fieldId),
  );
  if (shiftFields.size === 0) return null;
  const sourceYears = snapshots.flatMap((snapshot) =>
    [...shiftFields].flatMap((fieldId) => {
      const value = snapshot.values[fieldId];
      if (typeof value !== 'string') return [];
      const timestamp = Date.parse(value);
      return Number.isFinite(timestamp) ? [new Date(timestamp).getUTCFullYear()] : [];
    }),
  );
  if (sourceYears.length === 0) return null;
  const padding = calendarPadding(commands);
  const fromYear = Math.max(1, Math.min(...sourceYears) - padding - 1);
  const toYear = Math.min(9999, Math.max(...sourceYears) + padding + 1);
  let result: Awaited<ReturnType<BitrixAdapter['calendar']['getPortalCalendar']>>;
  try {
    result = await adapter.calendar.getPortalCalendar({ fromYear, toYear });
  } catch {
    return globalFailure('UPSTREAM_UNAVAILABLE');
  }
  if (!result.ok) {
    if (result.failure.kind === 'not_authenticated') return globalFailure('UNAUTHENTICATED');
    if (result.failure.kind === 'rate_limited') return globalFailure('RATE_LIMITED');
    return globalFailure('UPSTREAM_UNAVAILABLE');
  }
  const calendar = portalCalendarSchema.safeParse(result.value);
  if (!calendar.success) return globalFailure('UPSTREAM_UNAVAILABLE');
  return { calendar: calendar.data, fromYear, toYear };
}

function calculationFailureEntry(
  snapshot: TaskChangeSnapshot,
  error: TaskChangeCalculationError,
): PreflightTaskEntry {
  const invalidCurrent =
    error.code === 'MISSING_CURRENT_VALUE' || error.code === 'INVALID_CURRENT_VALUE';
  return excludedEntry({
    taskId: snapshot.taskId,
    title: snapshot.title,
    taskUrl: snapshot.taskUrl,
    relevantVersion: snapshot.relevantVersion,
    reasonCode: invalidCurrent ? 'INVALID_CURRENT_VALUE' : 'INVALID_CHANGE_RESULT',
    reasonMessage: invalidCurrent
      ? 'Текущее значение поля не поддерживает выбранное изменение.'
      : 'Новое значение не соответствует ограничениям изменения.',
  });
}

function targetUserIds(
  result: Extract<PreliminaryResult, { kind: 'calculated' }>,
  catalog: TaskChangeCatalogResponse,
): string[] {
  const fields = new Map(catalog.fields.map((field) => [field.id, field]));
  return Object.keys(result.calculation.targetValues).flatMap((fieldId) => {
    if (fields.get(fieldId)?.kind !== 'user') return [];
    const value = result.calculation.targetValues[fieldId];
    if (typeof value === 'string') return [value];
    return Array.isArray(value) ? value : [];
  });
}

function targetProjectIds(result: Extract<PreliminaryResult, { kind: 'calculated' }>): string[] {
  const value = result.calculation.targetValues.group_id;
  return typeof value === 'string' ? [value] : [];
}

async function loadUnavailableUserIds(
  adapter: BitrixAdapter,
  userIds: readonly string[],
): Promise<ReadonlySet<string>> {
  const uniqueIds = [...new Set(userIds)];
  const batches = Array.from(
    { length: Math.ceil(uniqueIds.length / directoryBatchSize) },
    (_, index) => uniqueIds.slice(index * directoryBatchSize, (index + 1) * directoryBatchSize),
  );
  const statuses = await mapConcurrent(batches, directoryConcurrency, async (batch) => {
    let result: Awaited<ReturnType<BitrixAdapter['users']['getAccessStatuses']>>;
    try {
      result = await adapter.users.getAccessStatuses(batch);
    } catch {
      return globalFailure('UPSTREAM_UNAVAILABLE');
    }
    if (!result.ok) {
      if (result.failure.kind === 'not_authenticated') return globalFailure('UNAUTHENTICATED');
      if (result.failure.kind === 'rate_limited') return globalFailure('RATE_LIMITED');
      return globalFailure('UPSTREAM_UNAVAILABLE');
    }
    const parsed = accessStatusListSchema.safeParse(result.value);
    if (!parsed.success) return globalFailure('UPSTREAM_UNAVAILABLE');
    const returnedIds = parsed.data.map((status) =>
      status.state === 'missing' ? status.userId : status.user.id,
    );
    if (
      new Set(returnedIds).size !== returnedIds.length ||
      returnedIds.length !== batch.length ||
      batch.some((id) => !returnedIds.includes(id))
    ) {
      return globalFailure('UPSTREAM_UNAVAILABLE');
    }
    return parsed.data;
  });
  return new Set(
    statuses.flat().flatMap((status) => {
      if (status.state === 'missing') return [status.userId];
      return status.state === 'active' && status.user.isActive ? [] : [status.user.id];
    }),
  );
}

async function loadUnavailableProjectIds(
  adapter: BitrixAdapter,
  projectIds: readonly string[],
): Promise<ReadonlySet<string>> {
  const uniqueIds = [...new Set(projectIds)];
  const batches = Array.from(
    { length: Math.ceil(uniqueIds.length / directoryBatchSize) },
    (_, index) => uniqueIds.slice(index * directoryBatchSize, (index + 1) * directoryBatchSize),
  );
  const statuses = await mapConcurrent(batches, directoryConcurrency, async (batch) => {
    let result: Awaited<ReturnType<BitrixAdapter['organization']['getProjectAccessStatuses']>>;
    try {
      result = await adapter.organization.getProjectAccessStatuses(batch);
    } catch {
      return globalFailure('UPSTREAM_UNAVAILABLE');
    }
    if (!result.ok) {
      if (result.failure.kind === 'not_authenticated') return globalFailure('UNAUTHENTICATED');
      if (result.failure.kind === 'rate_limited') return globalFailure('RATE_LIMITED');
      return globalFailure('UPSTREAM_UNAVAILABLE');
    }
    const parsed = projectAccessStatusListSchema.safeParse(result.value);
    if (!parsed.success) return globalFailure('UPSTREAM_UNAVAILABLE');
    const returnedIds = parsed.data.map((status) => status.projectId);
    if (
      new Set(returnedIds).size !== returnedIds.length ||
      returnedIds.length !== batch.length ||
      batch.some((id) => !returnedIds.includes(id))
    ) {
      return globalFailure('UPSTREAM_UNAVAILABLE');
    }
    return parsed.data;
  });
  return new Set(
    statuses
      .flat()
      .filter((status) => status.state === 'missing')
      .map((status) => status.projectId),
  );
}

function hasInvalidDateCombination(
  result: Extract<PreliminaryResult, { kind: 'calculated' }>,
): boolean {
  const hasDateContext = (['start_date', 'deadline'] as const).some(
    (fieldId) =>
      Object.hasOwn(result.calculation.targetValues, fieldId) ||
      Object.hasOwn(result.snapshot.values, fieldId),
  );
  if (!hasDateContext) return false;
  const value = (fieldId: 'start_date' | 'deadline') =>
    Object.hasOwn(result.calculation.targetValues, fieldId)
      ? result.calculation.targetValues[fieldId]
      : result.snapshot.values[fieldId];
  const startDate = value('start_date');
  const deadline = value('deadline');
  if (startDate === null || deadline === null) return false;
  if (typeof startDate !== 'string' || typeof deadline !== 'string') return true;
  const startTimestamp = Date.parse(startDate);
  const deadlineTimestamp = Date.parse(deadline);
  return (
    !Number.isFinite(startTimestamp) ||
    !Number.isFinite(deadlineTimestamp) ||
    startTimestamp > deadlineTimestamp
  );
}

function calculatedEntry(
  result: Extract<PreliminaryResult, { kind: 'calculated' }>,
  unavailableUserIds: ReadonlySet<string>,
  unavailableProjectIds: ReadonlySet<string>,
  catalog: TaskChangeCatalogResponse,
): PreflightTaskEntry {
  if (hasInvalidDateCombination(result)) {
    return excludedEntry({
      taskId: result.snapshot.taskId,
      title: result.snapshot.title,
      taskUrl: result.snapshot.taskUrl,
      relevantVersion: result.snapshot.relevantVersion,
      currentValues: result.calculation.currentValues,
      targetValues: result.calculation.targetValues,
      reasonCode: 'INVALID_FIELD_COMBINATION',
      reasonMessage: 'Дата начала не может быть позже крайнего срока.',
    });
  }
  const unavailableTarget = targetUserIds(result, catalog).some((id) => unavailableUserIds.has(id));
  if (unavailableTarget) {
    return excludedEntry({
      taskId: result.snapshot.taskId,
      title: result.snapshot.title,
      taskUrl: result.snapshot.taskUrl,
      relevantVersion: result.snapshot.relevantVersion,
      currentValues: result.calculation.currentValues,
      targetValues: result.calculation.targetValues,
      reasonCode: 'RELATED_USER_UNAVAILABLE',
      reasonMessage: 'Один из целевых участников недоступен или неактивен.',
    });
  }
  if (targetProjectIds(result).some((id) => unavailableProjectIds.has(id))) {
    return excludedEntry({
      taskId: result.snapshot.taskId,
      title: result.snapshot.title,
      taskUrl: result.snapshot.taskUrl,
      relevantVersion: result.snapshot.relevantVersion,
      currentValues: result.calculation.currentValues,
      targetValues: result.calculation.targetValues,
      reasonCode: 'RELATED_PROJECT_UNAVAILABLE',
      reasonMessage: 'Целевой проект или рабочая группа недоступны.',
    });
  }
  if (
    result.snapshot.deadlineManagedBySubtasks &&
    result.calculation.changedFieldIds.includes('deadline')
  ) {
    return excludedEntry({
      taskId: result.snapshot.taskId,
      title: result.snapshot.title,
      taskUrl: result.snapshot.taskUrl,
      relevantVersion: result.snapshot.relevantVersion,
      currentValues: result.calculation.currentValues,
      targetValues: result.calculation.targetValues,
      reasonCode: 'DEADLINE_MANAGED_BY_SUBTASKS',
      reasonMessage: 'Крайний срок управляется подзадачами.',
    });
  }
  return {
    taskId: result.snapshot.taskId,
    title: result.snapshot.title,
    taskUrl: result.snapshot.taskUrl,
    disposition: result.calculation.changedFieldIds.length === 0 ? 'no_change' : 'eligible',
    changedFieldIds: result.calculation.changedFieldIds,
    reasonCode: null,
    reasonMessage: null,
    relevantVersion: result.snapshot.relevantVersion,
    currentValues: result.calculation.currentValues,
    targetValues: result.calculation.targetValues,
  };
}

export async function buildTaskPreflight(
  input: BuildTaskPreflightInput,
): Promise<PreflightPreview> {
  const retryByTask = new Map(
    input.draft.retryIntents?.map((intent) => [intent.taskId, intent]) ?? [],
  );
  const fieldIds = input.draft.retryIntents
    ? [...new Set(input.draft.retryIntents.flatMap((intent) => Object.keys(intent.targetValues)))]
    : input.draft.changes.map((command) => command.fieldId);
  const fieldsForTask = (taskId: string) =>
    retryByTask.get(taskId) ? Object.keys(retryByTask.get(taskId)?.targetValues ?? {}) : fieldIds;
  const readFieldsForTask = (taskId: string) => {
    const fields = [...fieldsForTask(taskId)];
    if (fields.includes('start_date') || fields.includes('deadline')) {
      if (!fields.includes('start_date')) fields.push('start_date');
      if (!fields.includes('deadline')) fields.push('deadline');
    }
    return fields;
  };
  const consumeInputBytes = byteBudget(preflightApplicationByteLimit);
  const reads = await mapConcurrent(input.draft.selectedTaskIds, taskReadConcurrency, (taskId) =>
    readTask(
      input.adapter,
      taskId,
      readFieldsForTask(taskId),
      input.trustedPortalOrigins,
      consumeInputBytes,
    ),
  );
  const snapshots = reads.flatMap((result) =>
    result.kind === 'snapshot' ? [result.snapshot] : [],
  );
  const calculableSnapshots = snapshots.filter(
    (snapshot) =>
      !snapshot.isTemplate &&
      !snapshot.isRecurrenceRule &&
      snapshot.status !== 'completed' &&
      fieldsForTask(snapshot.taskId).every((fieldId) =>
        snapshot.editableFieldIds.includes(fieldId),
      ),
  );
  const calendar = await loadCalendar(
    input.adapter,
    input.draft.retryIntents ? [] : input.draft.changes,
    calculableSnapshots,
  );
  const preliminary = reads.map((result): PreliminaryResult => {
    if (result.kind !== 'snapshot') return result;
    const snapshot = result.snapshot;
    if (snapshot.isTemplate || snapshot.isRecurrenceRule) {
      return {
        kind: 'entry',
        entry: excludedEntry({
          taskId: snapshot.taskId,
          reasonCode: 'TASK_UNAVAILABLE',
          reasonMessage: 'Задача недоступна или не существует.',
        }),
      };
    }
    if (snapshot.status === 'completed') {
      return {
        kind: 'entry',
        entry: excludedEntry({
          taskId: snapshot.taskId,
          reasonCode: 'TASK_COMPLETED',
          reasonMessage: 'Завершённая задача недоступна для массового изменения.',
        }),
      };
    }
    if (
      !fieldsForTask(snapshot.taskId).every((fieldId) =>
        snapshot.editableFieldIds.includes(fieldId),
      )
    ) {
      return {
        kind: 'entry',
        entry: excludedEntry({
          taskId: snapshot.taskId,
          title: snapshot.title,
          taskUrl: snapshot.taskUrl,
          relevantVersion: snapshot.relevantVersion,
          reasonCode: 'FIELD_NOT_EDITABLE',
          reasonMessage: 'Нет права изменить одно или несколько выбранных полей.',
        }),
      };
    }
    try {
      const intent = retryByTask.get(snapshot.taskId);
      return {
        kind: 'calculated',
        snapshot,
        calculation: calculateTaskChanges({
          snapshot,
          commands: intent ? absoluteRetryCommands(intent, input.catalog) : input.draft.changes,
          catalog: input.catalog,
          calendar,
        }),
      };
    } catch (error) {
      if (error instanceof TaskChangeCalculationError) {
        return { kind: 'entry', entry: calculationFailureEntry(snapshot, error) };
      }
      if (
        input.draft.retryIntents &&
        (error instanceof z.ZodError ||
          error instanceof InvalidTaskChangeDefinitionError ||
          (error instanceof Error && error.message === 'Retry field is no longer available.'))
      ) {
        return {
          kind: 'entry',
          entry: excludedEntry({
            taskId: snapshot.taskId,
            title: snapshot.title,
            taskUrl: snapshot.taskUrl,
            relevantVersion: snapshot.relevantVersion,
            reasonCode: 'RETRY_TARGET_INVALID',
            reasonMessage: 'Исходная цель изменения больше недопустима для задачи.',
          }),
        };
      }
      return globalFailure('UPSTREAM_UNAVAILABLE');
    }
  });
  const unavailableUserIds = await loadUnavailableUserIds(
    input.adapter,
    preliminary.flatMap((result) =>
      result.kind === 'calculated' ? targetUserIds(result, input.catalog) : [],
    ),
  );
  const unavailableProjectIds = await loadUnavailableProjectIds(
    input.adapter,
    preliminary.flatMap((result) => (result.kind === 'calculated' ? targetProjectIds(result) : [])),
  );
  const consumeOutputBytes = byteBudget(preflightApplicationByteLimit - 4_096);
  const entries = preliminary.map((result) => {
    const entry =
      result.kind === 'entry'
        ? result.entry
        : calculatedEntry(result, unavailableUserIds, unavailableProjectIds, input.catalog);
    consumeOutputBytes(entry);
    return entry;
  });
  const eligible = entries.filter((entry) => entry.disposition === 'eligible').length;
  const excluded = entries.filter((entry) => entry.disposition === 'excluded_by_preflight').length;
  const unchanged = entries.filter((entry) => entry.disposition === 'no_change').length;
  const preview = preflightPreviewSchema.parse({
    draftId: input.draft.id,
    sourceDraftRevision: input.draft.revision,
    draftRevision: input.draft.revision + 1,
    actorAccessVersion: input.actorAccessVersion,
    checkedAt: (input.now ?? (() => new Date()))().toISOString(),
    canProceed: eligible > 0,
    entries,
    summary: {
      selected: entries.length,
      eligible,
      excluded,
      unchanged,
      successful: 0,
      failed: 0,
      unconfirmed: 0,
      conflicted: 0,
      partiallyApplied: 0,
      notProcessed: 0,
    },
  });
  return preview;
}
