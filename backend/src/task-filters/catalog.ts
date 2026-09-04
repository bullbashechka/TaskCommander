import {
  taskFilterCatalogResponseSchema,
  taskFilterOperatorsByKind,
  type TaskFilterCatalogResponse,
  type TaskFilterList,
} from '@task-commander/contracts';

import type { TaskFieldCapability, TaskSearchRequest } from '../integrations/bitrix/contract';

export function createTaskFilterCatalog(
  capabilities: readonly TaskFieldCapability[],
): TaskFilterCatalogResponse {
  return taskFilterCatalogResponseSchema.parse({
    version: 1,
    fields: capabilities.flatMap((capability) => {
      if (
        !capability.isSupported ||
        !capability.isFilterable ||
        capability.kind === null ||
        capability.filterValueSource === null
      ) {
        return [];
      }
      return [
        {
          id: capability.id,
          label: capability.filterLabel,
          kind: capability.kind,
          isMultiple: capability.isMultiple,
          isNullable: capability.isNullable,
          sortable: capability.isSortable,
          operators: taskFilterOperatorsByKind[capability.kind],
          valueSource: capability.filterValueSource,
          options: capability.filterOptions,
        },
      ];
    }),
  });
}

export class InvalidTaskSearchDefinitionError extends Error {}

export function requireValidTaskFilters(
  filters: TaskFilterList,
  catalog: TaskFilterCatalogResponse,
): void {
  const fieldsById = new Map(catalog.fields.map((field) => [field.id, field]));
  if (new Set(filters.map((filter) => filter.fieldId)).size !== filters.length) {
    throw new InvalidTaskSearchDefinitionError();
  }

  for (const filter of filters) {
    const field = fieldsById.get(filter.fieldId);
    if (!field || field.kind !== filter.kind || !field.operators.includes(filter.operator)) {
      throw new InvalidTaskSearchDefinitionError();
    }
    if (
      field.valueSource === 'options' &&
      filter.kind !== 'boolean' &&
      filter.values?.some(
        (value) =>
          typeof value !== 'string' || !field.options.some((option) => option.value === value),
      )
    ) {
      throw new InvalidTaskSearchDefinitionError();
    }
  }
}

export function requireValidTaskSearchDefinition(
  request: Pick<TaskSearchRequest, 'filters' | 'sort'>,
  catalog: TaskFilterCatalogResponse,
): void {
  const fieldsById = new Map(catalog.fields.map((field) => [field.id, field]));
  requireValidTaskFilters(request.filters, catalog);

  const sortField = fieldsById.get(request.sort.fieldId);
  if (!sortField?.sortable) throw new InvalidTaskSearchDefinitionError();
}
