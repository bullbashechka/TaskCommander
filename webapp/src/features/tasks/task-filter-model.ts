import {
  taskFilterListSchema,
  type TaskFilter,
  type TaskFilterField,
  type TaskFilterList,
  type TaskFilterOperator,
} from '@task-commander/contracts';

export type TaskFilterDraft = {
  key: string;
  fieldId: string;
  operator: TaskFilterOperator;
  values: string[];
};

export const operatorLabels: Readonly<Record<TaskFilterOperator, string>> = {
  contains: 'содержит',
  not_contains: 'не содержит',
  equals: 'равно',
  not_equals: 'не равно',
  before: 'до',
  after: 'после',
  between: 'диапазон',
  greater_than: 'больше',
  less_than: 'меньше',
  includes: 'включает',
  not_includes: 'не включает',
  is_set: 'заполнено',
  is_not_set: 'не заполнено',
};

export function operatorValueCount(operator: TaskFilterOperator): number | null {
  if (operator === 'is_set' || operator === 'is_not_set') return 0;
  if (operator === 'between') return 2;
  if (
    operator === 'before' ||
    operator === 'after' ||
    operator === 'greater_than' ||
    operator === 'less_than'
  ) {
    return 1;
  }
  return null;
}

export function createTaskFilterDraft(field: TaskFilterField): TaskFilterDraft {
  return {
    key: crypto.randomUUID(),
    fieldId: field.id,
    operator: field.operators[0]!,
    values: field.kind === 'boolean' ? ['true'] : [''],
  };
}

export function changeDraftOperator(
  draft: TaskFilterDraft,
  operator: TaskFilterOperator,
): TaskFilterDraft {
  const count = operatorValueCount(operator);
  return {
    ...draft,
    operator,
    values:
      count === 0
        ? []
        : count === null
          ? draft.values.length > 0
            ? draft.values
            : ['']
          : Array.from({ length: count }, (_, index) => draft.values[index] ?? ''),
  };
}

function localDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 23);
}

export function areTaskFiltersCompatibleWithCatalog(
  filters: TaskFilterList,
  fields: readonly TaskFilterField[],
): boolean {
  const fieldsById = new Map(fields.map((field) => [field.id, field]));
  return filters.every((filter) => {
    const field = fieldsById.get(filter.fieldId);
    if (!field || field.kind !== filter.kind || !field.operators.includes(filter.operator)) {
      return false;
    }
    if (field.valueSource !== 'options' || filter.kind === 'boolean') return true;
    const allowedValues = new Set(field.options.map((option) => option.value));
    return (filter.values ?? []).every(
      (value) => typeof value === 'string' && allowedValues.has(value),
    );
  });
}

function stringValues(filter: TaskFilter): string[] {
  if (filter.kind === 'boolean') return [String(filter.values[0])];
  if (filter.kind === 'date_time') return (filter.values ?? []).map(localDateTime);
  return (filter.values ?? []).map(String);
}

export function draftsFromFilters(filters: TaskFilterList): {
  titleSearch: string;
  drafts: TaskFilterDraft[];
} {
  let titleSearch = '';
  const drafts = filters.flatMap<TaskFilterDraft>((filter) => {
    if (
      filter.fieldId === 'title' &&
      filter.kind === 'text' &&
      filter.operator === 'contains' &&
      filter.values?.length === 1
    ) {
      titleSearch = filter.values[0]!;
      return [];
    }
    return [
      {
        key: crypto.randomUUID(),
        fieldId: filter.fieldId,
        operator: filter.operator,
        values: stringValues(filter),
      },
    ];
  });
  return { titleSearch, drafts };
}

function normalizeValues(field: TaskFilterField, values: string[]): unknown[] {
  const nonempty = values.filter((value) => value.trim() !== '');
  if (field.kind === 'number') return nonempty.map(Number);
  if (field.kind === 'boolean') return [nonempty[0] === 'true'];
  if (field.kind === 'date_time') {
    return nonempty.map((value) => {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? value : date.toISOString();
    });
  }
  return nonempty.map((value) => value.trim());
}

export function parseTaskFilterDrafts(
  titleSearch: string,
  drafts: readonly TaskFilterDraft[],
  fields: readonly TaskFilterField[],
): { success: true; filters: TaskFilterList } | { success: false; message: string } {
  const fieldsById = new Map(fields.map((field) => [field.id, field]));
  const rawFilters: unknown[] = [];
  if (titleSearch.trim()) {
    const title = fieldsById.get('title');
    if (!title || title.kind !== 'text' || !title.operators.includes('contains')) {
      return { success: false, message: 'Поиск по названию сейчас недоступен.' };
    }
    rawFilters.push({
      fieldId: title.id,
      kind: title.kind,
      operator: 'contains',
      values: [titleSearch.trim()],
    });
  }

  for (const draft of drafts) {
    const field = fieldsById.get(draft.fieldId);
    if (!field || !field.operators.includes(draft.operator)) {
      return { success: false, message: 'Состав доступных полей изменился. Обновите фильтр.' };
    }
    const valueCount = operatorValueCount(draft.operator);
    rawFilters.push({
      fieldId: field.id,
      kind: field.kind,
      operator: draft.operator,
      ...(valueCount === 0 ? {} : { values: normalizeValues(field, draft.values) }),
    });
  }

  const parsed = taskFilterListSchema.safeParse(rawFilters);
  if (!parsed.success) {
    return {
      success: false,
      message: 'Заполните значения условий и проверьте границы диапазонов.',
    };
  }
  return { success: true, filters: parsed.data };
}
