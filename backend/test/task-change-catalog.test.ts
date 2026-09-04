import { describe, expect, it } from 'vitest';

import type { TaskFieldCapability } from '../src/integrations/bitrix/contract';
import {
  createTaskChangeCatalog,
  InvalidTaskChangeDefinitionError,
  requireValidBulkChanges,
} from '../src/task-changes/catalog';

const baseCapability: TaskFieldCapability = {
  id: 'title',
  sourceType: 'string',
  kind: 'text',
  isMultiple: false,
  isNullable: false,
  isEditable: true,
  isSupported: true,
  filterLabel: 'Название',
  isFilterable: true,
  isSortable: true,
  filterValueSource: 'text',
  filterOptions: [],
};

function capability(overrides: Partial<TaskFieldCapability>): TaskFieldCapability {
  return { ...baseCapability, ...overrides };
}

describe('task change catalog', () => {
  it('filters completed values from a case-insensitive status field', () => {
    const catalog = createTaskChangeCatalog(
      [
        capability({
          id: 'STATUS',
          sourceType: 'enumeration',
          kind: 'list',
          filterLabel: 'Статус',
          filterValueSource: 'options',
          filterOptions: [
            { value: 'pending', label: 'Ждёт выполнения' },
            { value: 'COMPLETED', label: 'Завершена' },
          ],
        }),
      ],
      { kind: 'all' },
    );

    expect(catalog.fields[0]?.options).toEqual([{ value: 'pending', label: 'Ждёт выполнения' }]);
    expect(() =>
      requireValidBulkChanges(
        [{ fieldId: 'STATUS', kind: 'list', action: 'set', value: 'completed' }],
        catalog,
      ),
    ).toThrow(InvalidTaskChangeDefinitionError);
  });

  it('omits capability shapes that the command model cannot represent', () => {
    const catalog = createTaskChangeCatalog(
      [
        capability({ id: 'MULTI_TEXT', isMultiple: true }),
        capability({ id: 'SINGLE_TAGS', kind: 'tags' }),
        capability({
          id: 'TEXT_WITH_OPTIONS',
          filterValueSource: 'options',
          filterOptions: [{ value: 'one', label: 'Один' }],
        }),
        capability({
          id: 'VALID_LIST',
          sourceType: 'enumeration',
          kind: 'list',
          filterValueSource: 'options',
          filterOptions: [{ value: 'one', label: 'Один' }],
        }),
      ],
      { kind: 'all' },
    );

    expect(catalog.fields.map((field) => field.id)).toEqual(['VALID_LIST']);
  });

  it('keeps all supported fields and options beyond operation-level limits', () => {
    const catalog = createTaskChangeCatalog(
      [
        ...Array.from({ length: 257 }, (_, index) =>
          capability({ id: `UF_TEXT_${index}`, filterLabel: `Поле ${index}` }),
        ),
        capability({
          id: 'UF_LARGE_LIST',
          sourceType: 'enumeration',
          kind: 'list',
          filterLabel: 'Большой список',
          filterValueSource: 'options',
          filterOptions: Array.from({ length: 257 }, (_, index) => ({
            value: String(index),
            label: `Вариант ${index}`,
          })),
        }),
      ],
      { kind: 'all' },
    );

    expect(catalog.fields).toHaveLength(258);
    expect(catalog.fields.find((field) => field.id === 'UF_LARGE_LIST')?.options).toHaveLength(257);
  });
});
