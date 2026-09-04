import { z } from 'zod';

import {
  bitrixIdSchema,
  fieldIdSchema,
  isoDateTimeSchema,
  positiveIntegerSchema,
} from './primitives';

export const taskFieldKindSchema = z.enum([
  'text',
  'number',
  'boolean',
  'date_time',
  'user',
  'list',
  'tags',
]);

export type TaskFieldKind = z.infer<typeof taskFieldKindSchema>;

export const taskChangeValueSchema = z.union([
  z.string().max(4096),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(z.string().trim().min(1).max(4096)).max(256),
]);

export type TaskChangeValue = z.infer<typeof taskChangeValueSchema>;

export const taskFieldDefinitionSchema = z
  .object({
    id: fieldIdSchema,
    kind: taskFieldKindSchema,
    isMultiple: z.boolean(),
    isNullable: z.boolean(),
    isEditable: z.boolean(),
  })
  .strict();

export type TaskFieldDefinition = z.infer<typeof taskFieldDefinitionSchema>;

export const taskChangeActionSchema = z.enum(['set', 'clear', 'shift', 'replace', 'add', 'remove']);

export type TaskChangeAction = z.infer<typeof taskChangeActionSchema>;

export const taskChangeValueOptionSchema = z
  .object({
    value: z.string().trim().min(1).max(4096),
    label: z.string().trim().min(1).max(256),
  })
  .strict();

export const taskChangeFieldSchema = z
  .object({
    id: fieldIdSchema,
    label: z.string().trim().min(1).max(256),
    kind: taskFieldKindSchema,
    isMultiple: z.boolean(),
    isNullable: z.boolean(),
    valueSource: z.enum(['text', 'number', 'date_time', 'boolean', 'users', 'options']),
    options: z
      .array(taskChangeValueOptionSchema)
      .refine((options) => new Set(options.map((option) => option.value)).size === options.length),
    actions: z
      .array(taskChangeActionSchema)
      .min(1)
      .max(4)
      .refine((actions) => new Set(actions).size === actions.length),
  })
  .strict()
  .superRefine((field, context) => {
    const validSource =
      (field.kind === 'text' && field.valueSource === 'text') ||
      (field.kind === 'number' && field.valueSource === 'number') ||
      (field.kind === 'boolean' && field.valueSource === 'boolean') ||
      (field.kind === 'date_time' && field.valueSource === 'date_time') ||
      (field.kind === 'user' && field.valueSource === 'users') ||
      ((field.kind === 'list' || field.kind === 'tags') &&
        (field.valueSource === 'text' || field.valueSource === 'options'));
    if (!validSource) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['valueSource'],
        message: 'Value source must match the field kind.',
      });
    }
    if (
      (field.valueSource === 'options' && field.options.length === 0) ||
      (field.valueSource !== 'options' && field.options.length > 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: 'Options must match the value source.',
      });
    }
    const expectedActions: TaskChangeAction[] =
      field.isMultiple && ['user', 'list', 'tags'].includes(field.kind)
        ? ['replace', 'add', 'remove']
        : field.kind === 'date_time'
          ? ['set', 'shift']
          : ['set'];
    if (field.isNullable) expectedActions.push('clear');
    if (
      field.actions.length !== expectedActions.length ||
      field.actions.some((action, index) => action !== expectedActions[index])
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['actions'],
        message: 'Actions must match the field shape.',
      });
    }
  });

export type TaskChangeField = z.infer<typeof taskChangeFieldSchema>;

export const taskChangeCatalogResponseSchema = z
  .object({
    version: z.literal(1),
    fields: z
      .array(taskChangeFieldSchema)
      .refine((fields) => new Set(fields.map((field) => field.id)).size === fields.length),
  })
  .strict();

export type TaskChangeCatalogResponse = z.infer<typeof taskChangeCatalogResponseSchema>;

const textFilterSchema = z
  .object({
    kind: z.literal('text'),
    fieldId: fieldIdSchema,
    operator: z.enum(['contains', 'not_contains', 'equals', 'not_equals', 'is_set', 'is_not_set']),
    values: z.array(z.string().trim().min(1).max(4096)).max(50).optional(),
  })
  .strict();

const dateFilterSchema = z
  .object({
    kind: z.literal('date_time'),
    fieldId: fieldIdSchema,
    operator: z.enum(['equals', 'before', 'after', 'between', 'is_set', 'is_not_set']),
    values: z.array(isoDateTimeSchema).min(1).max(50).optional(),
  })
  .strict();

const numberFilterSchema = z
  .object({
    kind: z.literal('number'),
    fieldId: fieldIdSchema,
    operator: z.enum([
      'equals',
      'not_equals',
      'greater_than',
      'less_than',
      'between',
      'is_set',
      'is_not_set',
    ]),
    values: z.array(z.number().finite()).min(1).max(50).optional(),
  })
  .strict();

function createListFilterSchema(kind: 'list' | 'tags') {
  return z
    .object({
      kind: z.literal(kind),
      fieldId: fieldIdSchema,
      operator: z.enum([
        'includes',
        'not_includes',
        'equals',
        'not_equals',
        'is_set',
        'is_not_set',
      ]),
      values: z.array(z.string().trim().min(1).max(4096)).max(50).optional(),
    })
    .strict();
}

const userFilterSchema = z
  .object({
    kind: z.literal('user'),
    fieldId: fieldIdSchema,
    operator: z.enum(['equals', 'not_equals', 'includes', 'not_includes', 'is_set', 'is_not_set']),
    values: z.array(bitrixIdSchema).max(50).optional(),
  })
  .strict();

const booleanFilterSchema = z
  .object({
    kind: z.literal('boolean'),
    fieldId: fieldIdSchema,
    operator: z.enum(['equals']),
    values: z.tuple([z.boolean()]),
  })
  .strict();

export const taskFilterSchema = z
  .discriminatedUnion('kind', [
    textFilterSchema,
    dateFilterSchema,
    numberFilterSchema,
    createListFilterSchema('list'),
    createListFilterSchema('tags'),
    userFilterSchema,
    booleanFilterSchema,
  ])
  .superRefine((filter, context) => {
    if (filter.kind === 'boolean') return;

    const valuesCount = filter.values?.length ?? 0;
    if (filter.operator === 'is_set' || filter.operator === 'is_not_set') {
      if (filter.values !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['values'],
          message: 'Presence filters must not include values.',
        });
      }
      return;
    }

    const isSingleBoundaryOperator =
      filter.operator === 'before' ||
      filter.operator === 'after' ||
      filter.operator === 'greater_than' ||
      filter.operator === 'less_than';
    const expectedCount = filter.operator === 'between' ? 2 : isSingleBoundaryOperator ? 1 : null;
    if (expectedCount !== null && valuesCount !== expectedCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['values'],
        message:
          `This operator requires exactly ${expectedCount} ` +
          `value${expectedCount === 1 ? '' : 's'}.`,
      });
    }
    if (expectedCount === null && valuesCount === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['values'],
        message: 'This operator requires at least one value.',
      });
    }
    if (
      expectedCount === null &&
      filter.values !== undefined &&
      new Set(filter.values).size !== filter.values.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['values'],
        message: 'Filter values must be unique.',
      });
    }
    if (filter.kind === 'date_time' && filter.operator === 'between') {
      const [start, end] = filter.values ?? [];
      const reversed =
        start !== undefined && end !== undefined && Date.parse(start) > Date.parse(end);
      if (reversed) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['values'],
          message: 'Range boundaries must be ordered.',
        });
      }
    }
    if (filter.kind === 'number' && filter.operator === 'between') {
      const [start, end] = filter.values ?? [];
      if (start !== undefined && end !== undefined && start > end) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['values'],
          message: 'Range boundaries must be ordered.',
        });
      }
    }
  });

export type TaskFilter = z.infer<typeof taskFilterSchema>;

const setTextChangeSchema = z
  .object({
    fieldId: fieldIdSchema,
    kind: z.literal('text'),
    action: z.literal('set'),
    value: z.string().trim().min(1).max(4096),
  })
  .strict();

const setNumberChangeSchema = z
  .object({
    fieldId: fieldIdSchema,
    kind: z.literal('number'),
    action: z.literal('set'),
    value: z.number().finite(),
  })
  .strict();

const setBooleanChangeSchema = z
  .object({
    fieldId: fieldIdSchema,
    kind: z.literal('boolean'),
    action: z.literal('set'),
    value: z.boolean(),
  })
  .strict();

const setUserChangeSchema = z
  .object({
    fieldId: fieldIdSchema,
    kind: z.literal('user'),
    action: z.literal('set'),
    value: bitrixIdSchema,
  })
  .strict();

const setListChangeSchema = z
  .object({
    fieldId: fieldIdSchema,
    kind: z.literal('list'),
    action: z.literal('set'),
    value: z.string().trim().min(1).max(4096),
  })
  .strict();

const clearChangeSchema = z
  .object({
    fieldId: fieldIdSchema,
    kind: z.enum(['text', 'number', 'boolean', 'date_time', 'user', 'list', 'tags']),
    action: z.literal('clear'),
  })
  .strict();

const setDateChangeSchema = z
  .object({
    fieldId: fieldIdSchema,
    kind: z.literal('date_time'),
    action: z.literal('set'),
    value: isoDateTimeSchema,
  })
  .strict();

const shiftDateChangeSchema = z
  .object({
    fieldId: fieldIdSchema,
    kind: z.literal('date_time'),
    action: z.literal('shift'),
    direction: z.enum(['forward', 'backward']),
    days: positiveIntegerSchema.max(3660),
    calendar: z.enum(['calendar_days', 'working_days']),
  })
  .strict();

const userCollectionChangeSchema = z
  .object({
    fieldId: fieldIdSchema,
    kind: z.literal('user'),
    action: z.enum(['replace', 'add', 'remove']),
    values: z
      .array(bitrixIdSchema)
      .min(1)
      .max(256)
      .refine((values) => new Set(values).size === values.length),
  })
  .strict();

const stringCollectionChangeSchema = z
  .object({
    fieldId: fieldIdSchema,
    kind: z.enum(['list', 'tags']),
    action: z.enum(['replace', 'add', 'remove']),
    values: z
      .array(z.string().trim().min(1).max(4096))
      .min(1)
      .max(256)
      .refine((values) => new Set(values).size === values.length),
  })
  .strict();

export const bulkChangeCommandSchema = z.union([
  setTextChangeSchema,
  setNumberChangeSchema,
  setBooleanChangeSchema,
  setUserChangeSchema,
  setListChangeSchema,
  clearChangeSchema,
  setDateChangeSchema,
  shiftDateChangeSchema,
  userCollectionChangeSchema,
  stringCollectionChangeSchema,
]);

export type BulkChangeCommand = z.infer<typeof bulkChangeCommandSchema>;
