import { describe, expect, it } from 'vitest';

import type { TaskChangeCatalogResponse } from '@task-commander/contracts';

import {
  bulkChangeDraftsFromCommands,
  createBulkChangeDraft,
  parseBulkChangeDrafts,
} from './bulk-change-model';

const catalog: TaskChangeCatalogResponse = {
  version: 1,
  fields: [
    {
      id: 'title',
      label: 'Название',
      kind: 'text',
      isMultiple: false,
      isNullable: false,
      valueSource: 'text',
      options: [],
      actions: ['set'],
    },
    {
      id: 'deadline',
      label: 'Крайний срок',
      kind: 'date_time',
      isMultiple: false,
      isNullable: true,
      valueSource: 'date_time',
      options: [],
      actions: ['set', 'shift', 'clear'],
    },
    {
      id: 'tags',
      label: 'Теги',
      kind: 'tags',
      isMultiple: true,
      isNullable: true,
      valueSource: 'text',
      options: [],
      actions: ['replace', 'add', 'remove', 'clear'],
    },
    {
      id: 'UF_TASK_EFFORT',
      label: 'Трудозатраты',
      kind: 'number',
      isMultiple: false,
      isNullable: true,
      valueSource: 'number',
      options: [],
      actions: ['set', 'clear'],
    },
    {
      id: 'status',
      label: 'Статус',
      kind: 'list',
      isMultiple: false,
      isNullable: false,
      valueSource: 'options',
      options: [{ value: 'pending', label: 'Ждёт выполнения' }],
      actions: ['set'],
    },
    {
      id: 'UF_TASK_APPROVED',
      label: 'Согласовано',
      kind: 'boolean',
      isMultiple: false,
      isNullable: false,
      valueSource: 'boolean',
      options: [],
      actions: ['set'],
    },
  ],
};

describe('bulk change editor model', () => {
  it('creates multiple typed commands', () => {
    const title = { ...createBulkChangeDraft(catalog.fields[0]!), value: 'Новый заголовок' };
    const deadline = {
      ...createBulkChangeDraft(catalog.fields[1]!),
      action: 'shift' as const,
      direction: 'backward' as const,
      days: '3',
      calendar: 'working_days' as const,
    };
    const result = parseBulkChangeDrafts([title, deadline], catalog);

    expect(result).toEqual({
      success: true,
      commands: [
        { fieldId: 'title', kind: 'text', action: 'set', value: 'Новый заголовок' },
        {
          fieldId: 'deadline',
          kind: 'date_time',
          action: 'shift',
          direction: 'backward',
          days: 3,
          calendar: 'working_days',
        },
      ],
    });
  });

  it('rejects empty values, invalid shifts and duplicate fields', () => {
    expect(
      parseBulkChangeDrafts([createBulkChangeDraft(catalog.fields[0]!)], catalog).success,
    ).toBe(false);
    expect(
      parseBulkChangeDrafts(
        [
          {
            ...createBulkChangeDraft(catalog.fields[1]!),
            action: 'shift',
            days: '0',
          },
        ],
        catalog,
      ).success,
    ).toBe(false);
    const title = { ...createBulkChangeDraft(catalog.fields[0]!), value: 'A' };
    expect(parseBulkChangeDrafts([title, title], catalog)).toMatchObject({ success: false });
    expect(
      parseBulkChangeDrafts([createBulkChangeDraft(catalog.fields[3]!)], catalog).success,
    ).toBe(false);
  });

  it('drops commands that are no longer present in the effective catalog', () => {
    expect(
      bulkChangeDraftsFromCommands(
        [
          { fieldId: 'title', kind: 'text', action: 'set', value: 'A' },
          { fieldId: 'removed', kind: 'text', action: 'set', value: 'B' },
        ],
        catalog,
      ).map((draft) => draft.fieldId),
    ).toEqual(['title']);
  });

  it('drops a restored enum value removed from the current catalog', () => {
    expect(
      bulkChangeDraftsFromCommands(
        [{ fieldId: 'status', kind: 'list', action: 'set', value: 'completed' }],
        catalog,
      ),
    ).toEqual([]);
  });

  it('requires an explicit boolean choice and preserves false', () => {
    const empty = createBulkChangeDraft(catalog.fields[5]!);
    expect(parseBulkChangeDrafts([empty], catalog).success).toBe(false);
    expect(parseBulkChangeDrafts([{ ...empty, value: 'false' }], catalog)).toEqual({
      success: true,
      commands: [{ fieldId: 'UF_TASK_APPROVED', kind: 'boolean', action: 'set', value: false }],
    });
  });
});
