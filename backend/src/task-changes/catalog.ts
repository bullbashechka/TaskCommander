import {
  taskChangeCatalogResponseSchema,
  type BulkChangeCommand,
  type FieldScope,
  type TaskChangeAction,
  type TaskChangeCatalogResponse,
  type TaskChangeField,
} from '@task-commander/contracts';

import type { TaskFieldCapability } from '../integrations/bitrix/contract';

const excludedFieldIds = new Set([
  'attachments',
  'checklist',
  'checklist_items',
  'closed_date',
  'comments',
  'completed',
  'file_ids',
  'files',
  'recurrence',
  'replicate',
  'template_id',
  'uf_task_webdav_files',
]);

const completedStatusValues = new Set(['completed', 'complete', 'closed', '5']);

function actionsFor(capability: TaskFieldCapability): TaskChangeAction[] {
  const actions: TaskChangeAction[] = [];
  if (
    capability.isMultiple &&
    (capability.kind === 'user' || capability.kind === 'list' || capability.kind === 'tags')
  ) {
    actions.push('replace', 'add', 'remove');
  } else {
    actions.push('set');
    if (capability.kind === 'date_time') actions.push('shift');
  }
  if (capability.isNullable) actions.push('clear');
  return actions;
}

function valueSourceFor(capability: TaskFieldCapability): TaskChangeField['valueSource'] {
  if (capability.filterOptions.length > 0) return 'options';
  switch (capability.kind) {
    case 'text':
    case 'tags':
    case 'list':
      return 'text';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'date_time':
      return 'date_time';
    case 'user':
      return 'users';
    case null:
      throw new InvalidTaskChangeDefinitionError();
  }
}

function isAllowedByScope(fieldId: string, fieldScope: FieldScope): boolean {
  return fieldScope.kind === 'all' || fieldScope.fieldIds.includes(fieldId);
}

function isCommandShapeSupported(capability: TaskFieldCapability): boolean {
  if (capability.kind === null) return false;
  if (
    capability.isMultiple &&
    ['text', 'number', 'boolean', 'date_time'].includes(capability.kind)
  ) {
    return false;
  }
  if (capability.kind === 'tags' && !capability.isMultiple) return false;
  return (
    capability.filterOptions.length === 0 ||
    capability.kind === 'list' ||
    capability.kind === 'tags'
  );
}

export function createTaskChangeCatalog(
  capabilities: readonly TaskFieldCapability[],
  fieldScope: FieldScope,
): TaskChangeCatalogResponse {
  return taskChangeCatalogResponseSchema.parse({
    version: 1,
    fields: capabilities.flatMap((capability) => {
      if (
        !capability.isSupported ||
        !capability.isEditable ||
        capability.kind === null ||
        !isCommandShapeSupported(capability) ||
        excludedFieldIds.has(capability.id.toLowerCase()) ||
        !isAllowedByScope(capability.id, fieldScope)
      ) {
        return [];
      }
      const options = capability.filterOptions.filter(
        (option) =>
          capability.id.toLowerCase() !== 'status' ||
          !completedStatusValues.has(option.value.toLowerCase()),
      );
      if (capability.filterOptions.length > 0 && options.length === 0) return [];
      return [
        {
          id: capability.id,
          label: capability.filterLabel,
          kind: capability.kind,
          isMultiple: capability.isMultiple,
          isNullable: capability.isNullable,
          valueSource: valueSourceFor(capability),
          options,
          actions: actionsFor(capability),
        },
      ];
    }),
  });
}

export class InvalidTaskChangeDefinitionError extends Error {}

function commandValues(command: BulkChangeCommand): readonly string[] {
  if ('values' in command) return command.values;
  if ('value' in command && typeof command.value === 'string') return [command.value];
  return [];
}

export function requireValidBulkChanges(
  changes: readonly BulkChangeCommand[],
  catalog: TaskChangeCatalogResponse,
): void {
  if (new Set(changes.map((change) => change.fieldId)).size !== changes.length) {
    throw new InvalidTaskChangeDefinitionError();
  }
  const fields = new Map(catalog.fields.map((field) => [field.id, field]));
  for (const change of changes) {
    const field = fields.get(change.fieldId);
    if (!field || field.kind !== change.kind || !field.actions.includes(change.action)) {
      throw new InvalidTaskChangeDefinitionError();
    }
    if (
      field.valueSource === 'options' &&
      commandValues(change).some((value) => !field.options.some((option) => option.value === value))
    ) {
      throw new InvalidTaskChangeDefinitionError();
    }
    if (
      change.fieldId.toLowerCase() === 'status' &&
      commandValues(change).some((value) => completedStatusValues.has(value.toLowerCase()))
    ) {
      throw new InvalidTaskChangeDefinitionError();
    }
  }
}
