import { describe, expect, it } from 'vitest';

import {
  bulkChangeCommandSchema,
  saveBulkOperationDraftRequestSchema,
  taskChangeCatalogResponseSchema,
} from './index';

describe('task change contracts', () => {
  it('keeps scalar values tied to their field kind', () => {
    expect(
      bulkChangeCommandSchema.safeParse({
        fieldId: 'priority',
        kind: 'list',
        action: 'set',
        value: true,
      }).success,
    ).toBe(false);
    expect(
      bulkChangeCommandSchema.safeParse({
        fieldId: 'responsible_id',
        kind: 'user',
        action: 'set',
        value: 'not-a-bitrix-id',
      }).success,
    ).toBe(false);
    expect(
      bulkChangeCommandSchema.safeParse({
        fieldId: 'UF_TASK_APPROVED',
        kind: 'boolean',
        action: 'clear',
      }).success,
    ).toBe(true);
  });

  it('rejects duplicate collection values and duplicate draft fields', () => {
    expect(
      bulkChangeCommandSchema.safeParse({
        fieldId: 'tags',
        kind: 'tags',
        action: 'add',
        values: ['release', 'release'],
      }).success,
    ).toBe(false);
    expect(
      saveBulkOperationDraftRequestSchema.safeParse({
        expectedRevision: 0,
        replaceExpired: true,
        selectedTaskIds: ['42'],
        filters: [],
        sort: { fieldId: 'deadline', direction: 'asc' },
        changes: [
          { fieldId: 'title', kind: 'text', action: 'set', value: 'A' },
          { fieldId: 'title', kind: 'text', action: 'set', value: 'B' },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects changes that exceed the database JSON limit', () => {
    expect(
      saveBulkOperationDraftRequestSchema.safeParse({
        expectedRevision: 0,
        replaceExpired: true,
        selectedTaskIds: ['42'],
        filters: [],
        sort: { fieldId: 'deadline', direction: 'asc' },
        changes: Array.from({ length: 17 }, (_, index) => ({
          fieldId: `UF_LARGE_${index}`,
          kind: 'text',
          action: 'set',
          value: 'а'.repeat(4096),
        })),
      }).success,
    ).toBe(false);
  });

  it('accounts for PostgreSQL jsonb spacing in punctuation-dense changes', () => {
    const changes = Array.from({ length: 44 }, (_, fieldIndex) => ({
      fieldId: `UF_TAGS_${fieldIndex}`,
      kind: 'tags' as const,
      action: 'add' as const,
      values: Array.from({ length: 256 }, (_, valueIndex) => valueIndex.toString(36)),
    }));
    const compactSize = new TextEncoder().encode(JSON.stringify(changes)).byteLength;
    expect(compactSize).toBeLessThanOrEqual(65_536);
    expect(
      saveBulkOperationDraftRequestSchema.safeParse({
        expectedRevision: 0,
        replaceExpired: true,
        selectedTaskIds: ['42'],
        filters: [],
        sort: { fieldId: 'deadline', direction: 'asc' },
        changes,
      }).success,
    ).toBe(false);
  });

  it('accepts a punctuation-dense change set below the jsonb limit', () => {
    const changes = Array.from({ length: 40 }, (_, fieldIndex) => ({
      fieldId: `UF_TAGS_${fieldIndex}`,
      kind: 'tags' as const,
      action: 'add' as const,
      values: Array.from({ length: 256 }, (_, valueIndex) => valueIndex.toString(36)),
    }));
    expect(
      saveBulkOperationDraftRequestSchema.safeParse({
        expectedRevision: 0,
        replaceExpired: true,
        selectedTaskIds: ['42'],
        filters: [],
        sort: { fieldId: 'deadline', direction: 'asc' },
        changes,
      }).success,
    ).toBe(true);
  });

  it('does not impose operation limits on the change catalog', () => {
    expect(
      taskChangeCatalogResponseSchema.safeParse({
        version: 1,
        fields: Array.from({ length: 257 }, (_, fieldIndex) => ({
          id: `UF_LIST_${fieldIndex}`,
          label: `Поле ${fieldIndex}`,
          kind: 'list',
          isMultiple: false,
          isNullable: false,
          valueSource: 'options',
          options: Array.from({ length: 257 }, (_, optionIndex) => ({
            value: String(optionIndex),
            label: `Вариант ${optionIndex}`,
          })),
          actions: ['set'],
        })),
      }).success,
    ).toBe(true);
  });

  it('rejects a change catalog with mismatched value sources', () => {
    expect(
      taskChangeCatalogResponseSchema.safeParse({
        version: 1,
        fields: [
          {
            id: 'responsible_id',
            label: 'Исполнитель',
            kind: 'user',
            isMultiple: false,
            isNullable: false,
            valueSource: 'text',
            options: [],
            actions: ['set'],
          },
        ],
      }).success,
    ).toBe(false);
  });
});
