import { z } from 'zod';

import { bitrixIdSchema, fieldIdSchema, isoDateTimeSchema } from './primitives';
import { taskFieldKindSchema, taskFilterSchema, type TaskFieldKind } from './task-change';

export const taskFilterOperatorSchema = z.enum([
  'contains',
  'not_contains',
  'equals',
  'not_equals',
  'before',
  'after',
  'between',
  'greater_than',
  'less_than',
  'includes',
  'not_includes',
  'is_set',
  'is_not_set',
]);

export type TaskFilterOperator = z.infer<typeof taskFilterOperatorSchema>;

export const taskFilterOperatorsByKind = {
  text: ['contains', 'not_contains', 'equals', 'not_equals', 'is_set', 'is_not_set'],
  date_time: ['equals', 'before', 'after', 'between', 'is_set', 'is_not_set'],
  number: ['equals', 'not_equals', 'greater_than', 'less_than', 'between', 'is_set', 'is_not_set'],
  list: ['includes', 'not_includes', 'equals', 'not_equals', 'is_set', 'is_not_set'],
  tags: ['includes', 'not_includes', 'equals', 'not_equals', 'is_set', 'is_not_set'],
  user: ['equals', 'not_equals', 'includes', 'not_includes', 'is_set', 'is_not_set'],
  boolean: ['equals'],
} as const satisfies Readonly<Record<TaskFieldKind, readonly TaskFilterOperator[]>>;

export const taskFilterListSchema = z
  .array(taskFilterSchema)
  .max(256)
  .refine((filters) => new Set(filters.map((filter) => filter.fieldId)).size === filters.length, {
    message: 'A field can have only one filter condition.',
  });

export type TaskFilterList = z.infer<typeof taskFilterListSchema>;

export const taskFilterValueOptionSchema = z
  .object({
    value: z.string().trim().min(1).max(4096),
    label: z.string().trim().min(1).max(256),
  })
  .strict();

export const taskFilterFieldSchema = z
  .object({
    id: fieldIdSchema,
    label: z.string().trim().min(1).max(256),
    kind: taskFieldKindSchema,
    isMultiple: z.boolean(),
    isNullable: z.boolean(),
    sortable: z.boolean(),
    operators: z
      .array(taskFilterOperatorSchema)
      .min(1)
      .max(7)
      .refine((operators) => new Set(operators).size === operators.length),
    valueSource: z.enum(['text', 'number', 'date_time', 'boolean', 'users', 'options']),
    options: z
      .array(taskFilterValueOptionSchema)
      .refine((options) => new Set(options.map((option) => option.value)).size === options.length, {
        message: 'Option values must be unique.',
      }),
  })
  .strict()
  .superRefine((field, context) => {
    const expected = taskFilterOperatorsByKind[field.kind];
    if (
      field.operators.length !== expected.length ||
      field.operators.some((operator, index) => operator !== expected[index])
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['operators'],
        message: 'Field operators must match its kind.',
      });
    }
    const validSource =
      (field.kind === 'text' && field.valueSource === 'text') ||
      ((field.kind === 'list' || field.kind === 'tags') &&
        (field.valueSource === 'text' || field.valueSource === 'options')) ||
      (field.kind === 'user' && field.valueSource === 'users') ||
      (field.kind === 'number' && field.valueSource === 'number') ||
      (field.kind === 'date_time' && field.valueSource === 'date_time') ||
      (field.kind === 'boolean' && field.valueSource === 'boolean');
    const invalidSource =
      !validSource ||
      (field.valueSource === 'options' && field.options.length === 0) ||
      (field.valueSource !== 'options' && field.options.length > 0);
    if (invalidSource) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['valueSource'],
        message: 'Value source must match the field kind and options.',
      });
    }
  });

export type TaskFilterField = z.infer<typeof taskFilterFieldSchema>;

export const taskFilterCatalogResponseSchema = z
  .object({
    version: z.literal(1),
    fields: z
      .array(taskFilterFieldSchema)
      .refine((fields) => new Set(fields.map((field) => field.id)).size === fields.length),
  })
  .strict();

export type TaskFilterCatalogResponse = z.infer<typeof taskFilterCatalogResponseSchema>;

export const taskFilterUserSearchRequestSchema = z
  .object({
    q: z.string().trim().max(256).default(''),
    cursor: z.string().trim().min(1).max(128).nullable().default(null),
    pageSize: z.number().int().safe().min(1).max(50).default(20),
  })
  .strict();

export const taskFilterUserSchema = z
  .object({
    id: bitrixIdSchema,
    displayName: z.string().trim().min(1).max(256),
  })
  .strict();

export const taskFilterUserSearchResponseSchema = z
  .object({
    items: z.array(taskFilterUserSchema).max(50),
    nextCursor: z.string().trim().min(1).max(128).nullable(),
  })
  .strict();

export type TaskFilterUserSearchResponse = z.infer<typeof taskFilterUserSearchResponseSchema>;

const savedFilterRevisionSchema = z.number().int().safe().min(1).max(2_147_483_647);
const updatableSavedFilterRevisionSchema = savedFilterRevisionSchema.max(2_147_483_646);

export const savedTaskFilterSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    revision: savedFilterRevisionSchema,
    filters: taskFilterListSchema,
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export type SavedTaskFilter = z.infer<typeof savedTaskFilterSchema>;

export const savedTaskFilterListResponseSchema = z
  .object({ items: z.array(savedTaskFilterSchema).max(256) })
  .strict();

export const createSavedTaskFilterRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    filters: taskFilterListSchema,
  })
  .strict();

export const updateSavedTaskFilterRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    expectedRevision: updatableSavedFilterRevisionSchema,
  })
  .strict();

export const deleteSavedTaskFilterRequestSchema = z
  .object({ expectedRevision: savedFilterRevisionSchema })
  .strict();
