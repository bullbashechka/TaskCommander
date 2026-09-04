import { z } from 'zod';

import { bitrixIdSchema, fieldIdSchema, isoDateTimeSchema, safeHttpsUrlSchema } from './primitives';
import { taskFilterListSchema } from './task-filters';

export const taskSearchSortSchema = z
  .object({
    fieldId: fieldIdSchema,
    direction: z.enum(['asc', 'desc']),
  })
  .strict();

export const taskSearchApiRequestSchema = z
  .object({
    filters: taskFilterListSchema.default([]),
    sort: taskSearchSortSchema.default({ fieldId: 'deadline', direction: 'asc' }),
    page: z.number().int().safe().positive().default(1),
    pageSize: z.number().int().safe().positive().max(50).default(50),
  })
  .strict()
  .superRefine((request, context) => {
    if (!Number.isSafeInteger(request.page * request.pageSize)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['page'],
        message: 'Page range exceeds the safe integer range.',
      });
    }
  });

export type TaskSearchApiRequest = z.infer<typeof taskSearchApiRequestSchema>;

export const taskSelectAllApiRequestSchema = z
  .object({
    filters: taskFilterListSchema.default([]),
    sort: taskSearchSortSchema.default({ fieldId: 'deadline', direction: 'asc' }),
  })
  .strict();

export type TaskSelectAllApiRequest = z.infer<typeof taskSelectAllApiRequestSchema>;

export const taskSearchItemSchema = z
  .object({
    id: bitrixIdSchema,
    title: z.string().trim().min(1).max(1024),
    taskUrl: safeHttpsUrlSchema,
    parentId: bitrixIdSchema.nullable(),
    groupId: bitrixIdSchema.nullable(),
    status: z.enum(['pending', 'in_progress', 'pending_review', 'deferred']),
    responsibleId: bitrixIdSchema,
    responsibleName: z.string().trim().min(1).max(256).nullable(),
    deadline: isoDateTimeSchema.nullable(),
    priority: z.enum(['normal', 'high']),
    relevantVersion: z.string().trim().min(1).max(256),
  })
  .strict();

export type TaskSearchItem = z.infer<typeof taskSearchItemSchema>;

export const taskSearchApiResponseSchema = z
  .object({
    items: z.array(taskSearchItemSchema).max(50),
    total: z.number().int().safe().nonnegative(),
    page: z.number().int().safe().positive(),
    pageSize: z.number().int().safe().positive().max(50),
    hasNextPage: z.boolean(),
  })
  .strict()
  .superRefine((page, context) => {
    if (new Set(page.items.map((item) => item.id)).size !== page.items.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items'],
        message: 'Task IDs must be unique within a page.',
      });
    }
    if (page.items.length > page.total) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['total'],
        message: 'Total must include every returned item.',
      });
    }
  });

export type TaskSearchApiResponse = z.infer<typeof taskSearchApiResponseSchema>;

const selectedTasksResponseSchema = z
  .object({
    kind: z.literal('selected'),
    taskIds: z.array(bitrixIdSchema).min(1).max(1_000),
    total: z.number().int().safe().min(1).max(1_000),
  })
  .strict();

export const taskSelectAllApiResponseSchema = z
  .discriminatedUnion('kind', [
    selectedTasksResponseSchema,
    z.object({ kind: z.literal('empty'), total: z.literal(0) }).strict(),
    z
      .object({
        kind: z.literal('too_many'),
        total: z.number().int().safe().min(1_001),
      })
      .strict(),
  ])
  .superRefine((response, context) => {
    if (response.kind !== 'selected') return;
    if (new Set(response.taskIds).size !== response.taskIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['taskIds'],
        message: 'Selected task IDs must be unique.',
      });
    }
    if (response.taskIds.length !== response.total) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['total'],
        message: 'Selected task total must equal the number of task IDs.',
      });
    }
  });

export type TaskSelectAllApiResponse = z.infer<typeof taskSelectAllApiResponseSchema>;
