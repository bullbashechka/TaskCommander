import { describe, expect, it, vi } from 'vitest';

import type { TaskFilterField } from '@task-commander/contracts';

import {
  areTaskFiltersCompatibleWithCatalog,
  changeDraftOperator,
  createTaskFilterDraft,
  draftsFromFilters,
  parseTaskFilterDrafts,
} from './task-filter-model';

const fields: TaskFilterField[] = [
  {
    id: 'title',
    label: 'Название',
    kind: 'text',
    isMultiple: false,
    isNullable: false,
    sortable: true,
    operators: ['contains', 'not_contains', 'equals', 'not_equals', 'is_set', 'is_not_set'],
    valueSource: 'text',
    options: [],
  },
  {
    id: 'deadline',
    label: 'Крайний срок',
    kind: 'date_time',
    isMultiple: false,
    isNullable: true,
    sortable: true,
    operators: ['equals', 'before', 'after', 'between', 'is_set', 'is_not_set'],
    valueSource: 'date_time',
    options: [],
  },
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
];

describe('task filter draft model', () => {
  it('creates one canonical title condition and OR values for one field', () => {
    const parsed = parseTaskFilterDrafts(
      '  release  ',
      [
        {
          key: 'responsible',
          fieldId: 'responsible_id',
          operator: 'equals',
          values: ['10', '11'],
        },
      ],
      fields,
    );

    expect(parsed).toEqual({
      success: true,
      filters: [
        { kind: 'text', fieldId: 'title', operator: 'contains', values: ['release'] },
        {
          kind: 'user',
          fieldId: 'responsible_id',
          operator: 'equals',
          values: ['10', '11'],
        },
      ],
    });
  });

  it('converts local date values to UTC ISO values', () => {
    const parsed = parseTaskFilterDrafts(
      '',
      [
        {
          key: 'deadline',
          fieldId: 'deadline',
          operator: 'equals',
          values: ['2026-09-05T12:00'],
        },
      ],
      fields,
    );

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const value = parsed.filters[0]?.values?.[0];
    expect(value).toMatch(/Z$/);
    expect(new Date(String(value)).getTime()).toBe(new Date('2026-09-05T12:00').getTime());
  });

  it('rejects reversed date ranges', () => {
    const parsed = parseTaskFilterDrafts(
      '',
      [
        {
          key: 'deadline',
          fieldId: 'deadline',
          operator: 'between',
          values: ['2026-09-05T12:00', '2026-09-04T12:00'],
        },
      ],
      fields,
    );

    expect(parsed.success).toBe(false);
  });

  it('clears incompatible values when an operator changes', () => {
    const randomUuid = vi
      .spyOn(crypto, 'randomUUID')
      .mockReturnValue('00000000-0000-4000-8000-000000000000');
    const draft = createTaskFilterDraft(fields[1]!);

    expect(changeDraftOperator({ ...draft, values: ['one', 'two'] }, 'is_not_set').values).toEqual(
      [],
    );
    expect(changeDraftOperator(draft, 'between').values).toEqual(['', '']);
    randomUuid.mockRestore();
  });

  it('preserves every value when switching between compatible multi-value operators', () => {
    const draft = {
      key: 'responsible',
      fieldId: 'responsible_id',
      operator: 'equals' as const,
      values: ['10', '11', '12'],
    };

    expect(changeDraftOperator(draft, 'not_equals').values).toEqual(['10', '11', '12']);
  });

  it('rejects saved filters whose kind or option values no longer match the catalog', () => {
    expect(
      areTaskFiltersCompatibleWithCatalog(
        [{ kind: 'number', fieldId: 'title', operator: 'equals', values: [1] }],
        fields,
      ),
    ).toBe(false);
    expect(
      areTaskFiltersCompatibleWithCatalog(
        [{ kind: 'list', fieldId: 'priority', operator: 'equals', values: ['removed'] }],
        [
          ...fields,
          {
            id: 'priority',
            label: 'Приоритет',
            kind: 'list',
            isMultiple: false,
            isNullable: false,
            sortable: true,
            operators: ['includes', 'not_includes', 'equals', 'not_equals', 'is_set', 'is_not_set'],
            valueSource: 'options',
            options: [{ value: 'high', label: 'Высокий' }],
          },
        ],
      ),
    ).toBe(false);
  });

  it('restores the toolbar search without duplicating the title field', () => {
    expect(
      draftsFromFilters([
        { kind: 'text', fieldId: 'title', operator: 'contains', values: ['urgent'] },
      ]),
    ).toMatchObject({ titleSearch: 'urgent', drafts: [] });
  });

  it('round-trips date-time seconds and milliseconds without changing the instant', () => {
    const original = '2026-09-05T12:34:56.789+05:00';
    const restored = draftsFromFilters([
      { kind: 'date_time', fieldId: 'deadline', operator: 'equals', values: [original] },
    ]);
    const parsed = parseTaskFilterDrafts('', restored.drafts, fields);

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(new Date(parsed.filters[0]?.values?.[0] as string).getTime()).toBe(
      new Date(original).getTime(),
    );
  });
});
