import {
  bitrixIdSchema,
  bulkChangeCommandSchema,
  isoDateTimeSchema,
  taskChangeCatalogResponseSchema,
  type BulkChangeCommand,
  type TaskChangeAction,
  type TaskChangeCatalogResponse,
  type TaskChangeField,
  type TaskFieldKind,
} from '@task-commander/contracts';
import { z } from 'zod';

import type { PortalCalendar, TaskChangeSnapshot } from '../integrations/bitrix/contract';
import {
  bitrixTaskValueSchema,
  portalCalendarSchema,
  taskChangeSnapshotSchema,
} from '../integrations/bitrix/schemas';
import { InvalidTaskChangeDefinitionError, requireValidBulkChanges } from './catalog';

export type TaskChangeValue = string | number | boolean | null | string[];

export type TaskChangeCalculationErrorCode =
  | 'INVALID_INPUT'
  | 'MISSING_CURRENT_VALUE'
  | 'INVALID_CURRENT_VALUE'
  | 'RESULT_LIMIT_EXCEEDED'
  | 'CALENDAR_REQUIRED'
  | 'INVALID_CALENDAR'
  | 'CALENDAR_OUT_OF_RANGE'
  | 'INVALID_DATE'
  | 'NONEXISTENT_LOCAL_TIME'
  | 'DATE_OUT_OF_RANGE';

export class TaskChangeCalculationError extends Error {
  constructor(
    readonly code: TaskChangeCalculationErrorCode,
    readonly fieldId: string | null = null,
  ) {
    super(code);
    this.name = 'TaskChangeCalculationError';
  }
}

export interface PortalCalendarSnapshot {
  calendar: PortalCalendar;
  fromYear: number;
  toYear: number;
}

export interface CalculatedFieldChange {
  fieldId: string;
  kind: TaskFieldKind;
  action: TaskChangeAction;
  currentValue: TaskChangeValue;
  targetValue: TaskChangeValue;
  changed: boolean;
}

export interface TaskChangeCalculation {
  taskId: string;
  fieldChanges: CalculatedFieldChange[];
  currentValues: Record<string, TaskChangeValue>;
  targetValues: Record<string, TaskChangeValue>;
  changedFieldIds: string[];
}

export interface CalculateTaskChangesInput {
  snapshot: TaskChangeSnapshot;
  commands: readonly BulkChangeCommand[];
  catalog: TaskChangeCatalogResponse;
  calendar?: PortalCalendarSnapshot | null;
}

interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

interface ValidatedCalendar {
  calendar: PortalCalendar;
  fromYear: number;
  toYear: number;
  formatter: Intl.DateTimeFormat;
  workingWeekdays: ReadonlySet<number>;
  holidays: ReadonlySet<string>;
  exceptionalWorkingDays: ReadonlySet<string>;
}

const bulkChangeCommandListSchema = z.array(bulkChangeCommandSchema).min(1).max(64);

function fail(code: TaskChangeCalculationErrorCode, fieldId: string | null = null): never {
  throw new TaskChangeCalculationError(code, fieldId);
}

function cloneValue(value: TaskChangeValue): TaskChangeValue {
  return Array.isArray(value) ? [...value] : value;
}

function parseInputs(input: CalculateTaskChangesInput): {
  snapshot: TaskChangeSnapshot;
  commands: BulkChangeCommand[];
  catalog: TaskChangeCatalogResponse;
} {
  const snapshot = taskChangeSnapshotSchema.safeParse(input.snapshot);
  const catalog = taskChangeCatalogResponseSchema.safeParse(input.catalog);
  const commands = bulkChangeCommandListSchema.safeParse(input.commands);
  if (!snapshot.success || !catalog.success || !commands.success) fail('INVALID_INPUT');
  try {
    requireValidBulkChanges(commands.data, catalog.data);
  } catch (error) {
    if (error instanceof InvalidTaskChangeDefinitionError) fail('INVALID_INPUT');
    throw error;
  }
  return { snapshot: snapshot.data, commands: commands.data, catalog: catalog.data };
}

function isCollectionField(field: TaskChangeField): boolean {
  return field.isMultiple && ['user', 'list', 'tags'].includes(field.kind);
}

function validateCurrentValue(field: TaskChangeField, value: TaskChangeValue): void {
  if (value === null) {
    if (!field.isNullable) fail('INVALID_CURRENT_VALUE', field.id);
    return;
  }

  if (isCollectionField(field)) {
    if (!Array.isArray(value) || new Set(value).size !== value.length) {
      fail('INVALID_CURRENT_VALUE', field.id);
    }
    if (field.kind === 'user' && value.some((entry) => !bitrixIdSchema.safeParse(entry).success)) {
      fail('INVALID_CURRENT_VALUE', field.id);
    }
    return;
  }

  if (Array.isArray(value)) fail('INVALID_CURRENT_VALUE', field.id);
  const valid =
    (field.kind === 'text' && typeof value === 'string') ||
    (field.kind === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
    (field.kind === 'boolean' && typeof value === 'boolean') ||
    (field.kind === 'date_time' &&
      typeof value === 'string' &&
      isoDateTimeSchema.safeParse(value).success) ||
    (field.kind === 'user' &&
      typeof value === 'string' &&
      bitrixIdSchema.safeParse(value).success) ||
    (field.kind === 'list' && typeof value === 'string');
  if (!valid) fail('INVALID_CURRENT_VALUE', field.id);
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function dateKey(date: Pick<LocalDateTime, 'year' | 'month' | 'day'>): string {
  return `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}`;
}

function dateYear(value: string): number {
  return Number(value.slice(0, 4));
}

function validateCalendar(snapshot: PortalCalendarSnapshot | null | undefined): ValidatedCalendar {
  if (!snapshot) fail('CALENDAR_REQUIRED');
  const calendar = portalCalendarSchema.safeParse(snapshot.calendar);
  if (
    !calendar.success ||
    !Number.isInteger(snapshot.fromYear) ||
    !Number.isInteger(snapshot.toYear) ||
    snapshot.fromYear < 1 ||
    snapshot.toYear > 9999 ||
    snapshot.fromYear > snapshot.toYear
  ) {
    fail('INVALID_CALENDAR');
  }
  if (
    new Set(calendar.data.workingWeekdays).size !== calendar.data.workingWeekdays.length ||
    new Set(calendar.data.holidays).size !== calendar.data.holidays.length ||
    new Set(calendar.data.exceptionalWorkingDays).size !==
      calendar.data.exceptionalWorkingDays.length ||
    [...calendar.data.holidays, ...calendar.data.exceptionalWorkingDays].some((value) => {
      const year = dateYear(value);
      return year < snapshot.fromYear || year > snapshot.toYear;
    })
  ) {
    fail('INVALID_CALENDAR');
  }

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
      timeZone: calendar.data.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      era: 'short',
      hourCycle: 'h23',
    });
    formatter.format(new Date(0));
  } catch {
    fail('INVALID_CALENDAR');
  }
  return {
    calendar: calendar.data,
    fromYear: snapshot.fromYear,
    toYear: snapshot.toYear,
    formatter,
    workingWeekdays: new Set(calendar.data.workingWeekdays),
    holidays: new Set(calendar.data.holidays),
    exceptionalWorkingDays: new Set(calendar.data.exceptionalWorkingDays),
  };
}

function localParts(timestamp: number, formatter: Intl.DateTimeFormat): LocalDateTime {
  const parts = new Map(
    formatter
      .formatToParts(new Date(timestamp))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  const displayedYear = Number(parts.get('year'));
  const era = parts.get('era');
  const year = era === 'BC' ? 1 - displayedYear : displayedYear;
  const month = Number(parts.get('month'));
  const day = Number(parts.get('day'));
  const hour = Number(parts.get('hour'));
  const minute = Number(parts.get('minute'));
  const second = Number(parts.get('second'));
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second) ||
    (era !== 'AD' && era !== 'BC')
  ) {
    fail('INVALID_CALENDAR');
  }
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    millisecond: new Date(timestamp).getUTCMilliseconds(),
  };
}

function utcMilliseconds(parts: LocalDateTime): number {
  const date = new Date(0);
  date.setUTCHours(parts.hour, parts.minute, parts.second, parts.millisecond);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  return date.getTime();
}

function sameLocalDateTime(left: LocalDateTime, right: LocalDateTime): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.second === right.second &&
    left.millisecond === right.millisecond
  );
}

function localDateTimeToInstant(
  target: LocalDateTime,
  calendar: ValidatedCalendar,
  fieldId: string,
): string {
  const nominal = utcMilliseconds(target);
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = nominal + hours * 60 * 60 * 1000;
    offsets.add(utcMilliseconds(localParts(sample, calendar.formatter)) - sample);
  }
  const candidates = [...offsets]
    .map((offset) => nominal - offset)
    .filter((candidate) => sameLocalDateTime(localParts(candidate, calendar.formatter), target))
    .sort((left, right) => left - right);
  const instant = candidates[0];
  if (instant === undefined) fail('NONEXISTENT_LOCAL_TIME', fieldId);
  const result = new Date(instant);
  const utcYear = result.getUTCFullYear();
  if (utcYear < 1 || utcYear > 9999) fail('DATE_OUT_OF_RANGE', fieldId);
  return result.toISOString();
}

function addCivilDays(
  date: Pick<LocalDateTime, 'year' | 'month' | 'day'>,
  amount: number,
  fieldId: string,
): Pick<LocalDateTime, 'year' | 'month' | 'day'> {
  const instant = new Date(0);
  instant.setUTCHours(12, 0, 0, 0);
  instant.setUTCFullYear(date.year, date.month - 1, date.day + amount);
  const year = instant.getUTCFullYear();
  if (year < 1 || year > 9999) fail('DATE_OUT_OF_RANGE', fieldId);
  return { year, month: instant.getUTCMonth() + 1, day: instant.getUTCDate() };
}

function weekday(date: Pick<LocalDateTime, 'year' | 'month' | 'day'>): number {
  const instant = new Date(0);
  instant.setUTCHours(12, 0, 0, 0);
  instant.setUTCFullYear(date.year, date.month - 1, date.day);
  return instant.getUTCDay() || 7;
}

function ensureCovered(
  date: Pick<LocalDateTime, 'year' | 'month' | 'day'>,
  calendar: ValidatedCalendar,
  fieldId: string,
): void {
  if (date.year < calendar.fromYear || date.year > calendar.toYear) {
    fail('CALENDAR_OUT_OF_RANGE', fieldId);
  }
}

function isWorkingDay(
  date: Pick<LocalDateTime, 'year' | 'month' | 'day'>,
  calendar: ValidatedCalendar,
): boolean {
  const key = dateKey(date);
  if (calendar.exceptionalWorkingDays.has(key)) return true;
  return calendar.workingWeekdays.has(weekday(date)) && !calendar.holidays.has(key);
}

function shiftDate(
  value: string,
  command: Extract<BulkChangeCommand, { action: 'shift' }>,
  calendarSnapshot: PortalCalendarSnapshot | null | undefined,
): string {
  const sourceInstant = Date.parse(value);
  if (!Number.isFinite(sourceInstant)) fail('INVALID_DATE', command.fieldId);
  const calendar = validateCalendar(calendarSnapshot);
  const source = localParts(sourceInstant, calendar.formatter);
  ensureCovered(source, calendar, command.fieldId);
  const direction = command.direction === 'forward' ? 1 : -1;
  let targetDate: Pick<LocalDateTime, 'year' | 'month' | 'day'> = source;
  let remaining = command.days;
  while (remaining > 0) {
    targetDate = addCivilDays(targetDate, direction, command.fieldId);
    ensureCovered(targetDate, calendar, command.fieldId);
    if (command.calendar === 'calendar_days' || isWorkingDay(targetDate, calendar)) remaining -= 1;
  }
  return localDateTimeToInstant({ ...source, ...targetDate }, calendar, command.fieldId);
}

function calculateCollection(
  currentValue: TaskChangeValue,
  command: Extract<BulkChangeCommand, { action: 'replace' | 'add' | 'remove' }>,
): string[] {
  const current = currentValue === null ? [] : (currentValue as string[]);
  if (command.action === 'replace') return [...command.values];
  const requested = new Set(command.values);
  if (command.action === 'remove') return current.filter((value) => !requested.has(value));
  const result = [...current];
  const existing = new Set(current);
  for (const value of command.values) {
    if (!existing.has(value)) {
      result.push(value);
      existing.add(value);
    }
  }
  if (result.length > 256) fail('RESULT_LIMIT_EXCEEDED', command.fieldId);
  return result;
}

function calculateTargetValue(
  currentValue: TaskChangeValue,
  command: BulkChangeCommand,
  calendar: PortalCalendarSnapshot | null | undefined,
): TaskChangeValue {
  if (command.action === 'clear') return null;
  if (command.action === 'shift') {
    if (typeof currentValue !== 'string') fail('INVALID_CURRENT_VALUE', command.fieldId);
    return shiftDate(currentValue, command, calendar);
  }
  if (command.action === 'replace' || command.action === 'add' || command.action === 'remove') {
    return calculateCollection(currentValue, command);
  }
  return command.kind === 'date_time' ? new Date(command.value).toISOString() : command.value;
}

function valuesEqual(
  left: TaskChangeValue,
  right: TaskChangeValue,
  field: TaskChangeField,
): boolean {
  if (isCollectionField(field)) {
    const leftValues = left === null ? [] : left;
    const rightValues = right === null ? [] : right;
    if (!Array.isArray(leftValues) || !Array.isArray(rightValues)) return false;
    if (leftValues.length !== rightValues.length) return false;
    const rightSet = new Set(rightValues);
    return leftValues.every((value) => rightSet.has(value));
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return false;
  }
  if (field.kind === 'date_time' && typeof left === 'string' && typeof right === 'string') {
    return Date.parse(left) === Date.parse(right);
  }
  return left === right;
}

export function calculateTaskChanges(input: CalculateTaskChangesInput): TaskChangeCalculation {
  const { snapshot, commands, catalog } = parseInputs(input);
  const fields = new Map(catalog.fields.map((field) => [field.id, field]));
  const fieldChanges = commands.map((command): CalculatedFieldChange => {
    const field = fields.get(command.fieldId);
    if (!field) fail('INVALID_INPUT', command.fieldId);
    if (!Object.prototype.hasOwnProperty.call(snapshot.values, command.fieldId)) {
      fail('MISSING_CURRENT_VALUE', command.fieldId);
    }
    const currentValue = snapshot.values[command.fieldId];
    if (currentValue === undefined) fail('MISSING_CURRENT_VALUE', command.fieldId);
    validateCurrentValue(field, currentValue);
    const targetValue = calculateTargetValue(currentValue, command, input.calendar);
    if (!bitrixTaskValueSchema.safeParse(targetValue).success) {
      fail('RESULT_LIMIT_EXCEEDED', command.fieldId);
    }
    return {
      fieldId: command.fieldId,
      kind: command.kind,
      action: command.action,
      currentValue: cloneValue(currentValue),
      targetValue: cloneValue(targetValue),
      changed: !valuesEqual(currentValue, targetValue, field),
    };
  });
  return {
    taskId: snapshot.taskId,
    fieldChanges,
    currentValues: Object.fromEntries(
      fieldChanges.map((change) => [change.fieldId, cloneValue(change.currentValue)]),
    ),
    targetValues: Object.fromEntries(
      fieldChanges.map((change) => [change.fieldId, cloneValue(change.targetValue)]),
    ),
    changedFieldIds: fieldChanges
      .filter((change) => change.changed)
      .map((change) => change.fieldId),
  };
}
