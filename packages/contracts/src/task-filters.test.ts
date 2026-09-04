import { describe, expect, it } from 'vitest';

import {
  createSavedTaskFilterRequestSchema,
  deleteSavedTaskFilterRequestSchema,
  savedTaskFilterSchema,
  taskFilterCatalogResponseSchema,
  taskFilterListSchema,
  taskFilterOperatorsByKind,
  taskFilterUserSearchRequestSchema,
  updateSavedTaskFilterRequestSchema,
} from './task-filters';

describe('task filter contracts', () => {
  it('rejects duplicate field conditions', () => {
    expect(
      taskFilterListSchema.safeParse([
        { kind: 'text', fieldId: 'title', operator: 'contains', values: ['first'] },
        { kind: 'text', fieldId: 'title', operator: 'equals', values: ['second'] },
      ]).success,
    ).toBe(false);
  });

  it('accepts a strict versioned field catalog', () => {
    expect(
      taskFilterCatalogResponseSchema.parse({
        version: 1,
        fields: [
          {
            id: 'responsible_id',
            label: 'Исполнитель',
            kind: 'user',
            isMultiple: false,
            isNullable: false,
            sortable: true,
            operators: ['equals', 'not_equals', 'includes', 'not_includes', 'is_set', 'is_not_set'],
            valueSource: 'users',
            options: [],
          },
        ],
      }).fields[0]?.valueSource,
    ).toBe('users');
    expect(taskFilterCatalogResponseSchema.safeParse({ version: 2, fields: [] }).success).toBe(
      false,
    );
  });

  it('rejects duplicate catalog fields and operators', () => {
    const field = {
      id: 'title',
      label: 'Название',
      kind: 'text',
      isMultiple: false,
      isNullable: false,
      sortable: true,
      operators: ['contains', 'contains'],
      valueSource: 'text',
      options: [],
    };
    expect(taskFilterCatalogResponseSchema.safeParse({ version: 1, fields: [field] }).success).toBe(
      false,
    );
    expect(
      taskFilterCatalogResponseSchema.safeParse({
        version: 1,
        fields: [
          { ...field, operators: ['contains'] },
          { ...field, operators: ['equals'] },
        ],
      }).success,
    ).toBe(false);
    expect(
      taskFilterCatalogResponseSchema.safeParse({
        version: 1,
        fields: [{ ...field, operators: ['before'] }],
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate option values in the field catalog', () => {
    expect(
      taskFilterCatalogResponseSchema.safeParse({
        version: 1,
        fields: [
          {
            id: 'priority',
            label: 'Приоритет',
            kind: 'list',
            isMultiple: false,
            isNullable: false,
            sortable: true,
            operators: taskFilterOperatorsByKind.list,
            valueSource: 'options',
            options: [
              { value: 'high', label: 'Высокий' },
              { value: 'high', label: 'Дубликат' },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('normalizes saved filter names and limits persisted payloads', () => {
    expect(
      createSavedTaskFilterRequestSchema.parse({ name: '  Мои задачи  ', filters: [] }).name,
    ).toBe('Мои задачи');
    expect(
      createSavedTaskFilterRequestSchema.safeParse({
        name: 'Too many',
        filters: Array.from({ length: 257 }, (_, index) => ({
          kind: 'text',
          fieldId: `UF_TASK_${index}`,
          operator: 'equals',
          values: ['value'],
        })),
      }).success,
    ).toBe(false);
  });

  it('requires a valid revision and strict saved-filter timestamps', () => {
    expect(
      savedTaskFilterSchema.safeParse({
        id: 'da94a81c-9d88-4ce4-97d4-d94cbe225d42',
        name: 'Filter',
        revision: 0,
        filters: [],
        createdAt: '2026-09-04T10:00:00Z',
        updatedAt: '2026-09-04T10:00:00Z',
      }).success,
    ).toBe(false);
    expect(
      savedTaskFilterSchema.safeParse({
        id: 'da94a81c-9d88-4ce4-97d4-d94cbe225d42',
        name: 'Filter',
        revision: 1,
        filters: [],
        createdAt: '2026-09-04T10:00:00Z',
        updatedAt: 'not-a-timestamp',
      }).success,
    ).toBe(false);
    expect(
      updateSavedTaskFilterRequestSchema.safeParse({
        name: 'Filter',
        expectedRevision: 2_147_483_647,
      }).success,
    ).toBe(false);
    expect(
      deleteSavedTaskFilterRequestSchema.safeParse({ expectedRevision: 2_147_483_647 }).success,
    ).toBe(true);
    expect(deleteSavedTaskFilterRequestSchema.safeParse({ expectedRevision: 1e100 }).success).toBe(
      false,
    );
  });

  it('applies safe user-search defaults and rejects invalid cursors', () => {
    expect(taskFilterUserSearchRequestSchema.parse({})).toEqual({
      q: '',
      cursor: null,
      pageSize: 20,
    });
    expect(taskFilterUserSearchRequestSchema.safeParse({ cursor: '' }).success).toBe(false);
  });
});
