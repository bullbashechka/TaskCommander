import { describe, expect, it } from 'vitest';

import { createMockBitrixAdapter } from '../src/integrations/bitrix/mock';
import {
  createTaskFilterCatalog,
  InvalidTaskSearchDefinitionError,
  requireValidTaskFilters,
  requireValidTaskSearchDefinition,
} from '../src/task-filters/catalog';

describe('task filter catalog', () => {
  it('publishes separate participant fields and exact operators by field kind', async () => {
    const result = await createMockBitrixAdapter({
      currentUserId: '10',
    }).tasks.getFieldCapabilities();
    if (!result.ok) throw new Error('Expected mock capabilities');

    const catalog = createTaskFilterCatalog(result.value);
    expect(
      catalog.fields
        .filter((field) => field.kind === 'user')
        .map((field) => [field.id, field.label]),
    ).toEqual([
      ['creator_id', 'Постановщик'],
      ['responsible_id', 'Исполнитель'],
      ['accomplice_ids', 'Соисполнители'],
      ['auditor_ids', 'Наблюдатели'],
    ]);
    expect(catalog.fields.find((field) => field.id === 'title')?.operators).toEqual([
      'contains',
      'not_contains',
      'equals',
      'not_equals',
      'is_set',
      'is_not_set',
    ]);
    expect(catalog.fields.find((field) => field.id === 'priority')?.options).toEqual([
      { value: 'normal', label: 'Обычный' },
      { value: 'high', label: 'Высокий' },
    ]);
    expect(
      Object.fromEntries(
        [
          'title',
          'deadline',
          'UF_TASK_EFFORT',
          'priority',
          'tags',
          'responsible_id',
          'UF_TASK_APPROVED',
        ]
          .map((fieldId) => catalog.fields.find((field) => field.id === fieldId))
          .filter((field) => field !== undefined)
          .map((field) => [field.kind, field.operators]),
      ),
    ).toMatchObject({
      text: ['contains', 'not_contains', 'equals', 'not_equals', 'is_set', 'is_not_set'],
      date_time: ['equals', 'before', 'after', 'between', 'is_set', 'is_not_set'],
      number: [
        'equals',
        'not_equals',
        'greater_than',
        'less_than',
        'between',
        'is_set',
        'is_not_set',
      ],
      list: ['includes', 'not_includes', 'equals', 'not_equals', 'is_set', 'is_not_set'],
      tags: ['includes', 'not_includes', 'equals', 'not_equals', 'is_set', 'is_not_set'],
      user: ['equals', 'not_equals', 'includes', 'not_includes', 'is_set', 'is_not_set'],
      boolean: ['equals'],
    });
  });

  it('excludes unsupported capabilities', () => {
    expect(
      createTaskFilterCatalog([
        {
          id: 'unsupported',
          sourceType: 'file',
          kind: null,
          isMultiple: false,
          isNullable: true,
          isEditable: false,
          isSupported: false,
          filterLabel: 'Связь',
          isFilterable: false,
          isSortable: false,
          filterValueSource: null,
          filterOptions: [],
        },
      ]).fields,
    ).toEqual([]);
  });

  it('rejects option values absent from the current capability catalog', async () => {
    const result = await createMockBitrixAdapter({
      currentUserId: '10',
    }).tasks.getFieldCapabilities();
    if (!result.ok) throw new Error('Expected mock capabilities');
    const catalog = createTaskFilterCatalog(result.value);

    expect(() =>
      requireValidTaskFilters(
        [{ kind: 'list', fieldId: 'priority', operator: 'equals', values: ['removed'] }],
        catalog,
      ),
    ).toThrow(InvalidTaskSearchDefinitionError);
  });

  it('rejects sorting by a known field that the adapter marks non-sortable', async () => {
    const result = await createMockBitrixAdapter({
      currentUserId: '10',
    }).tasks.getFieldCapabilities();
    if (!result.ok) throw new Error('Expected mock capabilities');
    const catalog = createTaskFilterCatalog(
      result.value.map((field) =>
        field.id === 'deadline' ? { ...field, isSortable: false } : field,
      ),
    );

    expect(() =>
      requireValidTaskSearchDefinition(
        {
          filters: [],
          sort: { fieldId: 'deadline', direction: 'asc' },
          page: 1,
          pageSize: 50,
        },
        catalog,
      ),
    ).toThrow(InvalidTaskSearchDefinitionError);
  });

  it.each([
    {
      name: 'unknown field',
      request: {
        filters: [{ kind: 'text', fieldId: 'missing', operator: 'equals', values: ['x'] }],
        sort: { fieldId: 'deadline', direction: 'asc' },
        page: 1,
        pageSize: 50,
      },
    },
    {
      name: 'field kind mismatch',
      request: {
        filters: [{ kind: 'text', fieldId: 'deadline', operator: 'equals', values: ['x'] }],
        sort: { fieldId: 'deadline', direction: 'asc' },
        page: 1,
        pageSize: 50,
      },
    },
    {
      name: 'unknown sort',
      request: {
        filters: [],
        sort: { fieldId: 'missing', direction: 'asc' },
        page: 1,
        pageSize: 50,
      },
    },
  ])('rejects a search with $name', async ({ request }) => {
    const result = await createMockBitrixAdapter({
      currentUserId: '10',
    }).tasks.getFieldCapabilities();
    if (!result.ok) throw new Error('Expected mock capabilities');
    const catalog = createTaskFilterCatalog(result.value);

    expect(() => requireValidTaskSearchDefinition(request as never, catalog)).toThrow(
      InvalidTaskSearchDefinitionError,
    );
  });
});
