import { describe, expect, it } from 'vitest';

import { taskChangeCatalogResponseSchema, type BulkChangeCommand } from '@task-commander/contracts';

import type { PortalCalendar, TaskChangeSnapshot } from '../src/integrations/bitrix/contract';
import {
  calculateTaskChanges,
  TaskChangeCalculationError,
  type PortalCalendarSnapshot,
} from '../src/task-changes/calculation';

const catalog = taskChangeCatalogResponseSchema.parse({
  version: 1,
  fields: [
    {
      id: 'title',
      label: 'Title',
      kind: 'text',
      isMultiple: false,
      isNullable: false,
      valueSource: 'text',
      options: [],
      actions: ['set'],
    },
    {
      id: 'score',
      label: 'Score',
      kind: 'number',
      isMultiple: false,
      isNullable: true,
      valueSource: 'number',
      options: [],
      actions: ['set', 'clear'],
    },
    {
      id: 'approved',
      label: 'Approved',
      kind: 'boolean',
      isMultiple: false,
      isNullable: true,
      valueSource: 'boolean',
      options: [],
      actions: ['set', 'clear'],
    },
    {
      id: 'deadline',
      label: 'Deadline',
      kind: 'date_time',
      isMultiple: false,
      isNullable: true,
      valueSource: 'date_time',
      options: [],
      actions: ['set', 'shift', 'clear'],
    },
    {
      id: 'assignee',
      label: 'Assignee',
      kind: 'user',
      isMultiple: false,
      isNullable: true,
      valueSource: 'users',
      options: [],
      actions: ['set', 'clear'],
    },
    {
      id: 'watchers',
      label: 'Watchers',
      kind: 'user',
      isMultiple: true,
      isNullable: true,
      valueSource: 'users',
      options: [],
      actions: ['replace', 'add', 'remove', 'clear'],
    },
    {
      id: 'labels',
      label: 'Labels',
      kind: 'list',
      isMultiple: true,
      isNullable: true,
      valueSource: 'text',
      options: [],
      actions: ['replace', 'add', 'remove', 'clear'],
    },
    {
      id: 'tags',
      label: 'Tags',
      kind: 'tags',
      isMultiple: true,
      isNullable: true,
      valueSource: 'text',
      options: [],
      actions: ['replace', 'add', 'remove', 'clear'],
    },
  ],
});

function snapshot(values: TaskChangeSnapshot['values']): TaskChangeSnapshot {
  return {
    taskId: '42',
    title: 'Task',
    taskUrl: 'https://example.bitrix24.ru/company/personal/user/1/tasks/task/view/42/',
    status: 'in_progress',
    values,
    editableFieldIds: Object.keys(values),
    isTemplate: false,
    isRecurrenceRule: false,
    deadlineManagedBySubtasks: false,
    relevantVersion: 'version-1',
  };
}

function calendar(
  overrides: Partial<PortalCalendar> = {},
  coverage: Pick<PortalCalendarSnapshot, 'fromYear' | 'toYear'> = {
    fromYear: 2025,
    toYear: 2027,
  },
): PortalCalendarSnapshot {
  return {
    ...coverage,
    calendar: {
      timeZone: 'Europe/Moscow',
      workingWeekdays: [1, 2, 3, 4, 5],
      holidays: [],
      exceptionalWorkingDays: [],
      ...overrides,
    },
  };
}

function calculate(values: TaskChangeSnapshot['values'], commands: BulkChangeCommand[]) {
  return calculateTaskChanges({ snapshot: snapshot(values), commands, catalog });
}

describe('task change calculation', () => {
  it('calculates scalar set and nullable clear commands with both value snapshots', () => {
    const result = calculate({ title: 'Old', score: 12, approved: null, assignee: '10' }, [
      { fieldId: 'title', kind: 'text', action: 'set', value: 'New' },
      { fieldId: 'score', kind: 'number', action: 'clear' },
      { fieldId: 'approved', kind: 'boolean', action: 'set', value: false },
      { fieldId: 'assignee', kind: 'user', action: 'set', value: '11' },
    ]);

    expect(result.currentValues).toEqual({
      title: 'Old',
      score: 12,
      approved: null,
      assignee: '10',
    });
    expect(result.targetValues).toEqual({
      title: 'New',
      score: null,
      approved: false,
      assignee: '11',
    });
    expect(result.changedFieldIds).toEqual(['title', 'score', 'approved', 'assignee']);
  });

  it.each([
    {
      action: 'replace' as const,
      current: ['a', 'b'],
      requested: ['b', 'c'],
      expected: ['b', 'c'],
    },
    {
      action: 'add' as const,
      current: ['a', 'b'],
      requested: ['b', 'c'],
      expected: ['a', 'b', 'c'],
    },
    {
      action: 'remove' as const,
      current: ['a', 'b', 'c'],
      requested: ['missing', 'b'],
      expected: ['a', 'c'],
    },
  ])('$action applies exact collection semantics without mutating the source', (example) => {
    const current = [...example.current];
    const result = calculate({ tags: current }, [
      {
        fieldId: 'tags',
        kind: 'tags',
        action: example.action,
        values: example.requested,
      },
    ]);

    expect(result.targetValues.tags).toEqual(example.expected);
    expect(current).toEqual(example.current);
  });

  it('treats collection order as insignificant and add to null as an empty collection', () => {
    const reordered = calculate({ labels: ['one', 'two'] }, [
      {
        fieldId: 'labels',
        kind: 'list',
        action: 'replace',
        values: ['two', 'one'],
      },
    ]);
    const added = calculate({ watchers: null }, [
      { fieldId: 'watchers', kind: 'user', action: 'add', values: ['10'] },
    ]);

    expect(reordered.changedFieldIds).toEqual([]);
    expect(added.targetValues.watchers).toEqual(['10']);
  });

  it('treats null and an empty collection as equivalent', () => {
    const removed = calculate({ tags: null }, [
      { fieldId: 'tags', kind: 'tags', action: 'remove', values: ['missing'] },
    ]);
    const cleared = calculate({ tags: [] }, [{ fieldId: 'tags', kind: 'tags', action: 'clear' }]);

    expect(removed.targetValues.tags).toEqual([]);
    expect(removed.changedFieldIds).toEqual([]);
    expect(cleared.targetValues.tags).toBeNull();
    expect(cleared.changedFieldIds).toEqual([]);
  });

  it('canonicalizes absolute dates and compares equivalent instants semantically', () => {
    const result = calculate({ deadline: '2026-01-01T13:00:00+03:00' }, [
      {
        fieldId: 'deadline',
        kind: 'date_time',
        action: 'set',
        value: '2026-01-01T10:00:00Z',
      },
    ]);

    expect(result.targetValues.deadline).toBe('2026-01-01T10:00:00.000Z');
    expect(result.changedFieldIds).toEqual([]);
  });

  it('shifts working days in both directions using holidays and exceptional workdays', () => {
    const portalCalendar = calendar({
      holidays: ['2026-12-25'],
      exceptionalWorkingDays: ['2026-12-26'],
    });
    const forward = calculateTaskChanges({
      snapshot: snapshot({ deadline: '2026-12-24T06:45:30.123Z' }),
      commands: [
        {
          fieldId: 'deadline',
          kind: 'date_time',
          action: 'shift',
          direction: 'forward',
          days: 1,
          calendar: 'working_days',
        },
      ],
      catalog,
      calendar: portalCalendar,
    });
    const backward = calculateTaskChanges({
      snapshot: snapshot({ deadline: '2026-12-28T06:45:30.123Z' }),
      commands: [
        {
          fieldId: 'deadline',
          kind: 'date_time',
          action: 'shift',
          direction: 'backward',
          days: 1,
          calendar: 'working_days',
        },
      ],
      catalog,
      calendar: portalCalendar,
    });

    expect(forward.targetValues.deadline).toBe('2026-12-26T06:45:30.123Z');
    expect(backward.targetValues.deadline).toBe('2026-12-26T06:45:30.123Z');
  });

  it('preserves portal-local time across daylight-saving changes in both directions', () => {
    const berlin = calendar({ timeZone: 'Europe/Berlin' });
    const command = (direction: 'forward' | 'backward'): BulkChangeCommand => ({
      fieldId: 'deadline',
      kind: 'date_time',
      action: 'shift',
      direction,
      days: 3,
      calendar: 'calendar_days',
    });
    const forward = calculateTaskChanges({
      snapshot: snapshot({ deadline: '2026-03-27T08:15:30.123Z' }),
      commands: [command('forward')],
      catalog,
      calendar: berlin,
    });
    const backward = calculateTaskChanges({
      snapshot: snapshot({ deadline: '2026-10-26T08:15:30.123Z' }),
      commands: [command('backward')],
      catalog,
      calendar: berlin,
    });

    expect(forward.targetValues.deadline).toBe('2026-03-30T07:15:30.123Z');
    expect(backward.targetValues.deadline).toBe('2026-10-23T07:15:30.123Z');
  });

  it.each([
    ['2026-01-31T06:00:00Z', 'forward', '2026-02-01T06:00:00.000Z'],
    ['2024-03-01T06:00:00Z', 'backward', '2024-02-29T06:00:00.000Z'],
    ['2026-12-31T06:00:00Z', 'forward', '2027-01-01T06:00:00.000Z'],
  ] as const)('shifts the date boundary %s %s', (source, direction, expected) => {
    const result = calculateTaskChanges({
      snapshot: snapshot({ deadline: source }),
      commands: [
        {
          fieldId: 'deadline',
          kind: 'date_time',
          action: 'shift',
          direction,
          days: 1,
          calendar: 'calendar_days',
        },
      ],
      catalog,
      calendar: calendar({}, { fromYear: 2024, toYear: 2027 }),
    });

    expect(result.targetValues.deadline).toBe(expected);
  });

  it('chooses the earlier instant for an ambiguous local time and rejects a DST gap', () => {
    const berlin = calendar({ timeZone: 'Europe/Berlin' });
    const shift = {
      fieldId: 'deadline',
      kind: 'date_time',
      action: 'shift',
      direction: 'forward',
      days: 1,
      calendar: 'calendar_days',
    } as const;
    const overlap = calculateTaskChanges({
      snapshot: snapshot({ deadline: '2026-10-24T00:30:00Z' }),
      commands: [shift],
      catalog,
      calendar: berlin,
    });

    expect(overlap.targetValues.deadline).toBe('2026-10-25T00:30:00.000Z');
    expect(() =>
      calculateTaskChanges({
        snapshot: snapshot({ deadline: '2026-03-28T01:30:00Z' }),
        commands: [shift],
        catalog,
        calendar: berlin,
      }),
    ).toThrowError(expect.objectContaining({ code: 'NONEXISTENT_LOCAL_TIME' }));
  });

  it.each([
    {
      source: '0001-01-01T10:30:00Z',
      direction: 'backward' as const,
      timeZone: 'Etc/GMT-14',
      year: 1,
    },
    {
      source: '9999-12-31T11:30:00Z',
      direction: 'forward' as const,
      timeZone: 'Etc/GMT+12',
      year: 9999,
    },
  ])('rejects a shifted UTC result outside the ISO year range', (example) => {
    expect(() =>
      calculateTaskChanges({
        snapshot: snapshot({ deadline: example.source }),
        commands: [
          {
            fieldId: 'deadline',
            kind: 'date_time',
            action: 'shift',
            direction: example.direction,
            days: 1,
            calendar: 'calendar_days',
          },
        ],
        catalog,
        calendar: calendar(
          { timeZone: example.timeZone },
          { fromYear: example.year, toYear: example.year },
        ),
      }),
    ).toThrowError(expect.objectContaining({ code: 'DATE_OUT_OF_RANGE' }));
  });

  it('is deterministic and does not mutate inputs', () => {
    const input = {
      snapshot: snapshot({ tags: ['one'], deadline: '2026-01-30T06:00:00Z' }),
      commands: [
        { fieldId: 'tags', kind: 'tags', action: 'add', values: ['two'] },
        {
          fieldId: 'deadline',
          kind: 'date_time',
          action: 'shift',
          direction: 'forward',
          days: 2,
          calendar: 'calendar_days',
        },
      ] satisfies BulkChangeCommand[],
      catalog,
      calendar: calendar(),
    };
    const original = structuredClone(input);

    expect(calculateTaskChanges(input)).toEqual(calculateTaskChanges(input));
    expect(input).toEqual(original);
  });

  it.each([
    {
      name: 'a requested value is missing',
      values: {},
      command: { fieldId: 'title', kind: 'text', action: 'set', value: 'New' },
      code: 'MISSING_CURRENT_VALUE',
    },
    {
      name: 'the current value has the wrong kind',
      values: { score: '12' },
      command: { fieldId: 'score', kind: 'number', action: 'set', value: 13 },
      code: 'INVALID_CURRENT_VALUE',
    },
    {
      name: 'the current collection contains duplicates',
      values: { tags: ['same', 'same'] },
      command: { fieldId: 'tags', kind: 'tags', action: 'remove', values: ['same'] },
      code: 'INVALID_CURRENT_VALUE',
    },
  ])('fails closed when $name', ({ values, command, code }) => {
    expect(() => calculate(values, [command as BulkChangeCommand])).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it.each([
    {
      name: 'clear targets a non-nullable field',
      commands: [{ fieldId: 'title', kind: 'text', action: 'clear' }],
    },
    {
      name: 'two commands target the same field',
      commands: [
        { fieldId: 'title', kind: 'text', action: 'set', value: 'First' },
        { fieldId: 'title', kind: 'text', action: 'set', value: 'Second' },
      ],
    },
  ])('rejects invalid command combinations when $name', ({ commands }) => {
    expect(() =>
      calculateTaskChanges({
        snapshot: snapshot({ title: 'Current' }),
        commands: commands as BulkChangeCommand[],
        catalog,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('maps a malformed command container to a typed input failure', () => {
    expect(() =>
      calculateTaskChanges({
        snapshot: snapshot({ title: 'Current' }),
        commands: null as never,
        catalog,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('rejects a collection result above the adapter limit', () => {
    const current = Array.from({ length: 256 }, (_, index) => `tag-${index}`);

    expect(() =>
      calculate({ tags: current }, [
        { fieldId: 'tags', kind: 'tags', action: 'add', values: ['overflow'] },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'RESULT_LIMIT_EXCEEDED' }));
  });

  it.each([
    {
      calendar: undefined,
      code: 'CALENDAR_REQUIRED',
    },
    {
      calendar: calendar({ timeZone: 'Not/A_Time_Zone' }),
      code: 'INVALID_CALENDAR',
    },
    {
      calendar: calendar({}, { fromYear: 2025, toYear: 2025 }),
      code: 'CALENDAR_OUT_OF_RANGE',
    },
  ])('reports calendar failures as $code', ({ calendar: portalCalendar, code }) => {
    expect(() =>
      calculateTaskChanges({
        snapshot: snapshot({ deadline: '2026-01-01T10:00:00Z' }),
        commands: [
          {
            fieldId: 'deadline',
            kind: 'date_time',
            action: 'shift',
            direction: 'forward',
            days: 1,
            calendar: 'calendar_days',
          },
        ],
        catalog,
        calendar: portalCalendar,
      }),
    ).toThrowError(expect.objectContaining({ code }));
  });

  it('exposes typed failures without leaking task values in the message', () => {
    try {
      calculate({ title: 10 }, [
        { fieldId: 'title', kind: 'text', action: 'set', value: 'secret target' },
      ]);
      throw new Error('Expected calculation to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(TaskChangeCalculationError);
      expect(error).toMatchObject({ code: 'INVALID_CURRENT_VALUE', fieldId: 'title' });
      expect((error as Error).message).not.toContain('secret target');
    }
  });
});
