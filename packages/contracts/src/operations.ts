import { z } from 'zod';

import {
  bitrixIdSchema,
  draftIdSchema,
  fieldIdSchema,
  isoDateTimeSchema,
  nonNegativeIntegerSchema,
  operationIdSchema,
  positiveIntegerSchema,
  safeHttpsUrlSchema,
} from './primitives';
import { bulkChangeCommandSchema } from './task-change';
import { taskFilterListSchema } from './task-filters';
import { taskSearchSortSchema } from './task-search';

const textEncoder = new TextEncoder();

function postgresJsonbTextSizeUpperBound(value: unknown): number {
  if (value === null) return 4;
  if (typeof value === 'string') return textEncoder.encode(JSON.stringify(value)).byteLength;
  if (typeof value === 'boolean') return value ? 4 : 5;
  if (typeof value === 'number') {
    // PostgreSQL may expand an IEEE-754 exponent into plain decimal notation.
    return 326;
  }
  if (Array.isArray(value)) {
    return (
      2 +
      value.reduce((size, item) => size + postgresJsonbTextSizeUpperBound(item), 0) +
      Math.max(0, value.length - 1) * 2
    );
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    return (
      2 +
      entries.reduce(
        (size, [key, item]) =>
          size +
          textEncoder.encode(JSON.stringify(key)).byteLength +
          2 +
          postgresJsonbTextSizeUpperBound(item),
        0,
      ) +
      Math.max(0, entries.length - 1) * 2
    );
  }
  return Number.POSITIVE_INFINITY;
}

export const draftStatusSchema = z.enum(['preparing', 'awaiting_confirmation']);

export const preflightDispositionSchema = z.enum([
  'eligible',
  'excluded_by_preflight',
  'no_change',
]);

export const taskOutcomeStatusSchema = z.enum([
  'success',
  'error',
  'unconfirmed',
  'conflict',
  'excluded_by_preflight',
  'not_processed',
  'restored',
  'restore_error',
  'no_change',
  'partially_applied',
]);

export const operationStatusSchema = z.enum([
  'launching',
  'running',
  'completed',
  'completed_with_errors',
  'cancelled',
  'interrupted',
  'launch_failed',
]);

export const operationTypeSchema = z.enum(['bulk_change', 'retry', 'restore']);

export const operationSummarySchema = z
  .object({
    selected: nonNegativeIntegerSchema,
    eligible: nonNegativeIntegerSchema,
    excluded: nonNegativeIntegerSchema,
    unchanged: nonNegativeIntegerSchema,
    successful: nonNegativeIntegerSchema,
    failed: nonNegativeIntegerSchema,
    unconfirmed: nonNegativeIntegerSchema,
    conflicted: nonNegativeIntegerSchema,
    partiallyApplied: nonNegativeIntegerSchema,
    notProcessed: nonNegativeIntegerSchema,
  })
  .strict();

export const taskOutcomeRefinementSchema = z
  .object({
    outcome: z.enum([
      'success',
      'error',
      'conflict',
      'restored',
      'restore_error',
      'partially_applied',
    ]),
    appliedFieldIds: z.array(fieldIdSchema).max(256),
    failedFieldIds: z.array(fieldIdSchema).max(256),
    reasonCode: z.string().trim().min(1).max(128).nullable(),
    reasonMessage: z.string().trim().min(1).max(512).nullable(),
    canRetry: z.boolean(),
    refinedAt: isoDateTimeSchema,
  })
  .strict();

export const preflightTaskEntrySchema = z
  .object({
    taskId: bitrixIdSchema,
    title: z.string().trim().min(1).max(1024).nullable(),
    taskUrl: safeHttpsUrlSchema.nullable(),
    disposition: preflightDispositionSchema,
    changedFieldIds: z.array(fieldIdSchema).max(256),
    reasonCode: z.string().trim().min(1).max(128).nullable(),
    reasonMessage: z.string().trim().min(1).max(512).nullable(),
    relevantVersion: z.string().trim().min(1).max(256).nullable(),
  })
  .strict();

export const preflightPreviewSchema = z
  .object({
    draftId: draftIdSchema,
    draftRevision: positiveIntegerSchema,
    checkedAt: isoDateTimeSchema,
    entries: z.array(preflightTaskEntrySchema).max(1000),
    summary: operationSummarySchema,
  })
  .strict();

export const bulkOperationDraftSchema = z
  .object({
    id: draftIdSchema,
    ownerId: bitrixIdSchema,
    revision: positiveIntegerSchema,
    status: draftStatusSchema,
    filters: taskFilterListSchema,
    sort: taskSearchSortSchema,
    selectedTaskIds: z
      .array(bitrixIdSchema)
      .min(1)
      .max(1000)
      .refine((taskIds) => new Set(taskIds).size === taskIds.length),
    changes: z
      .array(bulkChangeCommandSchema)
      .min(1)
      .max(64)
      .refine(
        (changes) => new Set(changes.map((change) => change.fieldId)).size === changes.length,
      ),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    expiresAt: isoDateTimeSchema,
  })
  .strict();

export const bulkOperationDraftAvailabilitySchema = z
  .object({ draft: bulkOperationDraftSchema.nullable() })
  .strict();

export const saveBulkOperationDraftRequestSchema = z
  .object({
    expectedRevision: nonNegativeIntegerSchema,
    replaceExpired: z.boolean().default(false),
    selectedTaskIds: z
      .array(bitrixIdSchema)
      .min(1)
      .max(1000)
      .refine((taskIds) => new Set(taskIds).size === taskIds.length),
    filters: taskFilterListSchema.default([]),
    sort: taskSearchSortSchema,
    changes: z
      .array(bulkChangeCommandSchema)
      .min(1)
      .max(64)
      .refine(
        (changes) => new Set(changes.map((change) => change.fieldId)).size === changes.length,
      ),
  })
  .strict()
  .superRefine((request, context) => {
    const changesSize = postgresJsonbTextSizeUpperBound(request.changes);
    if (changesSize > 65_536) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['changes'],
        message: 'Serialized changes exceed the storage limit.',
      });
    }
    const requestSize = textEncoder.encode(JSON.stringify(request)).byteLength;
    if (requestSize > 120_000) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Serialized draft exceeds the request limit.',
      });
    }
  });

export const taskOutcomeSchema = z
  .object({
    taskId: bitrixIdSchema,
    title: z.string().trim().min(1).max(1024).nullable(),
    taskUrl: safeHttpsUrlSchema.nullable(),
    outcome: taskOutcomeStatusSchema,
    changedFieldIds: z.array(fieldIdSchema).max(256),
    appliedFieldIds: z.array(fieldIdSchema).max(256),
    failedFieldIds: z.array(fieldIdSchema).max(256),
    reasonCode: z.string().trim().min(1).max(128).nullable(),
    reasonMessage: z.string().trim().min(1).max(512).nullable(),
    canRetry: z.boolean(),
    refinement: taskOutcomeRefinementSchema.nullable(),
  })
  .strict();

export const bulkOperationSchema = z
  .object({
    id: operationIdSchema,
    type: operationTypeSchema,
    status: operationStatusSchema,
    stateVersion: positiveIntegerSchema,
    launchAttempt: positiveIntegerSchema,
    initiatorId: bitrixIdSchema,
    sourceOperationId: operationIdSchema.nullable(),
    createdAt: isoDateTimeSchema,
    startedAt: isoDateTimeSchema.nullable(),
    completedAt: isoDateTimeSchema.nullable(),
    cancelRequestedAt: isoDateTimeSchema.nullable(),
    interruptionRequestedAt: isoDateTimeSchema.nullable(),
    interruptionReasonCode: z.string().trim().min(1).max(128).nullable(),
    summary: operationSummarySchema,
  })
  .strict();

export const reportArtifactStatusSchema = z.enum([
  'pending',
  'generating',
  'awaiting_upload',
  'ready',
  'failed',
  'unavailable',
]);

export const reportArtifactSchema = z
  .object({
    format: z.enum(['xlsx', 'csv']),
    status: reportArtifactStatusSchema,
    diskUrl: safeHttpsUrlSchema.nullable(),
    createdAt: isoDateTimeSchema.nullable(),
  })
  .strict();

export const reportTaskEntrySchema = z
  .object({
    taskId: bitrixIdSchema,
    title: z.string().trim().min(1).max(1024).nullable(),
    taskUrl: safeHttpsUrlSchema.nullable(),
    outcome: taskOutcomeStatusSchema,
    changedFieldIds: z.array(fieldIdSchema).max(256),
    reasonCode: z.string().trim().min(1).max(128).nullable().optional(),
    reasonMessage: z.string().trim().min(1).max(512).nullable().optional(),
  })
  .strict();

export type BulkOperationDraft = z.infer<typeof bulkOperationDraftSchema>;
export type BulkOperationDraftAvailability = z.infer<typeof bulkOperationDraftAvailabilitySchema>;
export type SaveBulkOperationDraftRequest = z.infer<typeof saveBulkOperationDraftRequestSchema>;
export type BulkOperation = z.infer<typeof bulkOperationSchema>;
export type TaskOutcome = z.infer<typeof taskOutcomeSchema>;
export type TaskOutcomeRefinement = z.infer<typeof taskOutcomeRefinementSchema>;
