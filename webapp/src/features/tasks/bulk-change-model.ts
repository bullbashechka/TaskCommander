import {
  bulkChangeCommandSchema,
  type BulkChangeCommand,
  type TaskChangeAction,
  type TaskChangeCatalogResponse,
  type TaskChangeField,
} from '@task-commander/contracts';

export type BulkChangeDraft = {
  fieldId: string;
  action: TaskChangeAction;
  value: string;
  values: string[];
  direction: 'forward' | 'backward';
  days: string;
  calendar: 'calendar_days' | 'working_days';
};

export type BulkChangeParseResult =
  | { success: true; commands: BulkChangeCommand[] }
  | { success: false; errors: Readonly<Record<string, string>> };

export function createBulkChangeDraft(field: TaskChangeField): BulkChangeDraft {
  return {
    fieldId: field.id,
    action: field.actions[0]!,
    value: '',
    values: [],
    direction: 'forward',
    days: '1',
    calendar: 'calendar_days',
  };
}

export function changeBulkChangeAction(
  draft: BulkChangeDraft,
  field: TaskChangeField,
  action: TaskChangeAction,
): BulkChangeDraft {
  return { ...createBulkChangeDraft({ ...field, actions: [action] }), fieldId: draft.fieldId };
}

function commandFromDraft(
  draft: BulkChangeDraft,
  field: TaskChangeField,
): BulkChangeCommand | null {
  if (!field.actions.includes(draft.action)) return null;
  if (draft.action === 'clear') {
    const parsed = bulkChangeCommandSchema.safeParse({
      fieldId: field.id,
      kind: field.kind,
      action: 'clear',
    });
    return parsed.success ? parsed.data : null;
  }
  if (draft.action === 'shift' && field.kind === 'date_time') {
    const parsed = bulkChangeCommandSchema.safeParse({
      fieldId: field.id,
      kind: field.kind,
      action: 'shift',
      direction: draft.direction,
      days: Number(draft.days),
      calendar: draft.calendar,
    });
    return parsed.success ? parsed.data : null;
  }
  if (draft.action === 'replace' || draft.action === 'add' || draft.action === 'remove') {
    const values = [...new Set(draft.values.map((value) => value.trim()).filter(Boolean))];
    const parsed = bulkChangeCommandSchema.safeParse({
      fieldId: field.id,
      kind: field.kind,
      action: draft.action,
      values,
    });
    return parsed.success ? parsed.data : null;
  }
  if (draft.action !== 'set') return null;

  let value: string | number | boolean = draft.value.trim();
  if (field.kind === 'number') {
    if (draft.value.trim() === '') return null;
    value = Number(draft.value);
  }
  if (field.kind === 'boolean') {
    if (draft.value !== 'true' && draft.value !== 'false') return null;
    value = draft.value === 'true';
  }
  if (field.kind === 'date_time') {
    const timestamp = Date.parse(draft.value);
    if (Number.isNaN(timestamp)) return null;
    value = new Date(timestamp).toISOString();
  }
  const parsed = bulkChangeCommandSchema.safeParse({
    fieldId: field.id,
    kind: field.kind,
    action: 'set',
    value,
  });
  return parsed.success ? parsed.data : null;
}

export function parseBulkChangeDrafts(
  drafts: readonly BulkChangeDraft[],
  catalog: TaskChangeCatalogResponse,
): BulkChangeParseResult {
  const errors: Record<string, string> = {};
  const commands: BulkChangeCommand[] = [];
  if (drafts.length === 0)
    return { success: false, errors: { form: 'Добавьте хотя бы одно поле.' } };
  if (new Set(drafts.map((draft) => draft.fieldId)).size !== drafts.length) {
    return { success: false, errors: { form: 'Каждое поле можно изменить только один раз.' } };
  }
  const fields = new Map(catalog.fields.map((field) => [field.id, field]));
  for (const draft of drafts) {
    const field = fields.get(draft.fieldId);
    if (!field) {
      errors[draft.fieldId] = 'Поле больше недоступно.';
      continue;
    }
    const command = commandFromDraft(draft, field);
    if (!command) {
      errors[draft.fieldId] =
        draft.action === 'shift'
          ? 'Укажите целое число дней от 1 до 3660.'
          : 'Укажите допустимое значение.';
      continue;
    }
    const stringValues =
      'values' in command
        ? command.values
        : 'value' in command && typeof command.value === 'string'
          ? [command.value]
          : [];
    if (
      field.valueSource === 'options' &&
      stringValues.some((value) => !field.options.some((option) => option.value === value))
    ) {
      errors[draft.fieldId] = 'Выберите значение из доступного списка.';
      continue;
    }
    commands.push(command);
  }
  return Object.keys(errors).length > 0 ? { success: false, errors } : { success: true, commands };
}

export function hasCompatibleOptionValues(draft: BulkChangeDraft, field: TaskChangeField): boolean {
  if (field.valueSource !== 'options') return true;
  const values = ['replace', 'add', 'remove'].includes(draft.action)
    ? draft.values.filter(Boolean)
    : draft.value
      ? [draft.value]
      : [];
  return values.every((value) => field.options.some((option) => option.value === value));
}

export function bulkChangeDraftsFromCommands(
  commands: readonly BulkChangeCommand[],
  catalog: TaskChangeCatalogResponse,
): BulkChangeDraft[] {
  const fields = new Map(catalog.fields.map((field) => [field.id, field]));
  return commands.flatMap((command) => {
    const field = fields.get(command.fieldId);
    if (!field || field.kind !== command.kind || !field.actions.includes(command.action)) return [];
    const draft = createBulkChangeDraft(field);
    draft.action = command.action;
    if ('value' in command) {
      draft.value =
        command.kind === 'date_time'
          ? new Date(
              new Date(command.value).getTime() -
                new Date(command.value).getTimezoneOffset() * 60_000,
            )
              .toISOString()
              .slice(0, 16)
          : String(command.value);
    }
    if ('values' in command) draft.values = [...command.values];
    if (command.action === 'shift') {
      draft.direction = command.direction;
      draft.days = String(command.days);
      draft.calendar = command.calendar;
    }
    return hasCompatibleOptionValues(draft, field) ? [draft] : [];
  });
}
