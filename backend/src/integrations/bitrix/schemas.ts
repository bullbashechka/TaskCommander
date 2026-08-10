import { z } from 'zod';

import {
  bitrixIdSchema,
  fieldIdSchema,
  isoDateTimeSchema,
  taskFieldKindSchema,
  taskFilterSchema,
} from '@task-commander/contracts';

export const bitrixTaskValueSchema = z.union([
  z.string().max(4096),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string().trim().min(1).max(4096)).max(256),
]);

export const bitrixFailureSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('not_authenticated') }).strict(),
  z.object({ kind: z.literal('permission_denied') }).strict(),
  z.object({ kind: z.literal('not_found_or_forbidden') }).strict(),
  z
    .object({
      kind: z.literal('rate_limited'),
      limit: z.enum(['intensity', 'operation_time']),
      retryAt: isoDateTimeSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('temporary_failure'),
      reasonCode: z.string().trim().min(1).max(128),
    })
    .strict(),
  z
    .object({
      kind: z.literal('permanent_failure'),
      reasonCode: z.string().trim().min(1).max(128),
      fieldIds: z.array(fieldIdSchema).max(256),
    })
    .strict(),
  z.object({ kind: z.literal('invalid_external_response') }).strict(),
  z
    .object({
      kind: z.literal('unsupported_capability'),
      capability: z.string().trim().min(1).max(128),
    })
    .strict(),
]);

export const taskFieldCapabilitySchema = z
  .object({
    id: fieldIdSchema,
    sourceType: z.string().trim().min(1).max(128),
    kind: taskFieldKindSchema.nullable(),
    isMultiple: z.boolean(),
    isNullable: z.boolean(),
    isEditable: z.boolean(),
    isSupported: z.boolean(),
  })
  .strict();

export const taskSummarySchema = z
  .object({
    id: bitrixIdSchema,
    title: z.string().trim().min(1).max(1024),
    taskUrl: z.string().url(),
    parentId: bitrixIdSchema.nullable(),
    status: z.enum(['pending', 'in_progress', 'pending_review', 'deferred']),
    responsibleId: bitrixIdSchema,
    deadline: isoDateTimeSchema.nullable(),
    priority: z.enum(['normal', 'high']),
  })
  .strict();

export const taskSearchRequestSchema = z
  .object({
    filters: z.array(taskFilterSchema).max(64),
    sort: z
      .object({
        fieldId: fieldIdSchema,
        direction: z.enum(['asc', 'desc']),
      })
      .strict(),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive().max(50),
  })
  .strict();

export const taskSearchPageSchema = z
  .object({
    items: z.array(taskSummarySchema).max(50),
    total: z.number().int().nonnegative(),
    hasNextPage: z.boolean(),
  })
  .strict();

export const taskChangeSnapshotSchema = z
  .object({
    taskId: bitrixIdSchema,
    title: z.string().trim().min(1).max(1024).nullable(),
    taskUrl: z.string().url().nullable(),
    status: z.enum(['pending', 'in_progress', 'pending_review', 'deferred', 'completed']),
    values: z.record(fieldIdSchema, bitrixTaskValueSchema),
    editableFieldIds: z.array(fieldIdSchema).max(256),
    deadlineManagedBySubtasks: z.boolean(),
    relevantVersion: z.string().trim().min(1).max(256),
  })
  .strict();

export const taskReadForChangeRequestSchema = z
  .object({
    taskId: bitrixIdSchema,
    fieldIds: z.array(fieldIdSchema).min(1).max(256),
  })
  .strict();

export const taskApplyRequestSchema = z
  .object({
    taskId: bitrixIdSchema,
    expectedRelevantVersion: z.string().trim().min(1).max(256),
    targetValues: z.record(fieldIdSchema, bitrixTaskValueSchema).refine(
      (values) => Object.keys(values).length > 0,
      'At least one target value is required.',
    ),
  })
  .strict();

export const taskApplyOutcomeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('success'),
      appliedFieldIds: z.array(fieldIdSchema).min(1).max(256),
    })
    .strict(),
  z.object({ kind: z.literal('no_change') }).strict(),
  z
    .object({
      kind: z.literal('conflict'),
      reason: z.literal('state_changed'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('partially_applied'),
      appliedFieldIds: z.array(fieldIdSchema).min(1).max(256),
      failedFieldIds: z.array(fieldIdSchema).min(1).max(256),
    })
    .strict(),
]);

export const bitrixUserSchema = z
  .object({
    id: bitrixIdSchema,
    displayName: z.string().trim().min(1).max(256),
    isActive: z.boolean(),
    isAdmin: z.boolean(),
    departmentIds: z.array(bitrixIdSchema).max(256),
  })
  .strict();

export const bitrixDepartmentSchema = z
  .object({
    id: bitrixIdSchema,
    name: z.string().trim().min(1).max(256),
    parentId: bitrixIdSchema.nullable(),
    headUserId: bitrixIdSchema.nullable(),
  })
  .strict();

export const portalCalendarSchema = z
  .object({
    timeZone: z.string().trim().min(1).max(128),
    workingWeekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    holidays: z.array(z.string().date()).max(1000),
    exceptionalWorkingDays: z.array(z.string().date()).max(1000),
  })
  .strict();

export const notificationRequestSchema = z
  .object({
    recipientId: bitrixIdSchema,
    deduplicationKey: z.string().trim().min(1).max(256),
    message: z.string().trim().min(1).max(4096),
    operationUrl: z.string().url(),
  })
  .strict();

export const notificationSchema = z
  .object({
    id: z.string().uuid(),
    recipientId: bitrixIdSchema,
    deduplicationKey: z.string().trim().min(1).max(256),
    message: z.string().trim().min(1).max(4096),
    operationUrl: z.string().url(),
  })
  .strict();

export const reportAccessGrantSchema = z
  .object({
    principal: z.enum(['user', 'department']),
    id: bitrixIdSchema,
    level: z.literal('read'),
  })
  .strict();

export const diskPutReportRequestSchema = z
  .object({
    operationId: z.string().uuid(),
    format: z.enum(['xlsx', 'csv']),
    fileName: z.string().trim().min(1).max(512),
    content: z.instanceof(Uint8Array),
    contentHash: z.string().trim().min(1).max(256),
    access: z.array(reportAccessGrantSchema).max(256),
  })
  .strict();

export const diskFileSchema = z
  .object({
    id: bitrixIdSchema,
    operationId: z.string().uuid(),
    format: z.enum(['xlsx', 'csv']),
    name: z.string().trim().min(1).max(512),
    url: z.string().url(),
    folder: z.enum(['active', 'archive']),
    contentHash: z.string().trim().min(1).max(256),
    access: z.array(reportAccessGrantSchema).max(256),
  })
  .strict();
