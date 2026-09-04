import { describe, expect, it } from 'vitest';

import { taskSearchApiRequestSchema, taskSearchApiResponseSchema } from './task-search';

describe('task search contracts', () => {
  it('applies the documented deadline-first defaults', () => {
    expect(taskSearchApiRequestSchema.parse({})).toEqual({
      filters: [],
      sort: { fieldId: 'deadline', direction: 'asc' },
      page: 1,
      pageSize: 50,
    });
  });

  it.each([
    {
      name: 'a missing scalar value',
      filter: { kind: 'text', fieldId: 'title', operator: 'contains' },
    },
    {
      name: 'values on a presence operator',
      filter: { kind: 'text', fieldId: 'title', operator: 'is_set', values: [] },
    },
    {
      name: 'one boundary for between',
      filter: {
        kind: 'date_time',
        fieldId: 'deadline',
        operator: 'between',
        values: ['2026-09-01T10:00:00+05:00'],
      },
    },
  ])('rejects $name', ({ filter }) => {
    expect(taskSearchApiRequestSchema.safeParse({ filters: [filter] }).success).toBe(false);
  });

  it('accepts multiple values for operators with OR semantics', () => {
    expect(
      taskSearchApiRequestSchema.safeParse({
        filters: [
          {
            kind: 'user',
            fieldId: 'responsible_id',
            operator: 'equals',
            values: ['10', '11'],
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('rejects duplicate fields and reversed ranges', () => {
    expect(
      taskSearchApiRequestSchema.safeParse({
        filters: [
          { kind: 'text', fieldId: 'title', operator: 'contains', values: ['one'] },
          { kind: 'text', fieldId: 'title', operator: 'contains', values: ['two'] },
        ],
      }).success,
    ).toBe(false);
    expect(
      taskSearchApiRequestSchema.safeParse({
        filters: [
          {
            kind: 'date_time',
            fieldId: 'deadline',
            operator: 'between',
            values: ['2026-09-05T10:00:00+05:00', '2026-09-04T10:00:00+05:00'],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      taskSearchApiRequestSchema.safeParse({
        filters: [
          {
            kind: 'number',
            fieldId: 'effort',
            operator: 'between',
            values: [10, 5],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      taskSearchApiRequestSchema.safeParse({
        filters: [{ kind: 'number', fieldId: 'effort', operator: 'equals', values: [Infinity] }],
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate OR values', () => {
    expect(
      taskSearchApiRequestSchema.safeParse({
        filters: [
          {
            kind: 'user',
            fieldId: 'responsible_id',
            operator: 'equals',
            values: ['10', '10'],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects the date-time not-equals operator absent from the PRD matrix', () => {
    expect(
      taskSearchApiRequestSchema.safeParse({
        filters: [
          {
            kind: 'date_time',
            fieldId: 'deadline',
            operator: 'not_equals',
            values: ['2026-09-04T10:00:00Z'],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects a page whose upper boundary exceeds the safe integer range', () => {
    expect(
      taskSearchApiRequestSchema.safeParse({
        page: Number.MAX_SAFE_INTEGER,
        pageSize: 2,
      }).success,
    ).toBe(false);
  });

  it('requires a control version for every returned task', () => {
    expect(
      taskSearchApiResponseSchema.safeParse({
        items: [
          {
            id: '42',
            title: 'Task',
            taskUrl: 'https://portal.bitrix24.ru/tasks/42',
            parentId: null,
            status: 'in_progress',
            responsibleId: '10',
            deadline: null,
            priority: 'normal',
          },
        ],
        total: 1,
        page: 1,
        pageSize: 50,
        hasNextPage: false,
      }).success,
    ).toBe(false);
  });
});
