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
    selectedTaskIds: z.array(bitrixIdSchema).min(1).max(1000),
    changes: z.array(bulkChangeCommandSchema).min(1).max(64),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    expiresAt: isoDateTimeSchema,
  })
  .strict();

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
export type BulkOperation = z.infer<typeof bulkOperationSchema>;
export type TaskOutcome = z.infer<typeof taskOutcomeSchema>;
export type TaskOutcomeRefinement = z.infer<typeof taskOutcomeRefinementSchema>;
