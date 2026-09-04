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

const scalarValueSchema = z.union([z.string().max(4096), z.number(), z.boolean(), bitrixIdSchema]);

const setScalarChangeSchema = z
  .object({
    fieldId: fieldIdSchema,
    kind: z.enum(['text', 'number', 'boolean', 'user', 'list']),
    action: z.literal('set'),
    value: scalarValueSchema,
  })
  .strict();

const clearChangeSchema = z
  .object({
    fieldId: fieldIdSchema,
    kind: z.enum(['text', 'number', 'date_time', 'user', 'list', 'tags']),
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

const collectionChangeSchema = z
  .object({
    fieldId: fieldIdSchema,
    kind: z.enum(['user', 'list', 'tags']),
    action: z.enum(['replace', 'add', 'remove']),
    values: z.array(z.string().trim().min(1)).min(1).max(256),
  })
  .strict();

export const bulkChangeCommandSchema = z.union([
  setScalarChangeSchema,
  clearChangeSchema,
  setDateChangeSchema,
  shiftDateChangeSchema,
  collectionChangeSchema,
]);

export type BulkChangeCommand = z.infer<typeof bulkChangeCommandSchema>;
