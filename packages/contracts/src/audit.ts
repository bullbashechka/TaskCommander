import { z } from 'zod';

import { permissionSchema } from './access';

import {
  bitrixIdSchema,
  correlationIdSchema,
  fieldIdSchema,
  isoDateTimeSchema,
  nonNegativeIntegerSchema,
  positiveIntegerSchema,
} from './primitives';

const displayNameSchema = z.string().trim().min(1).max(256);
const subjectIdSchema = z.string().trim().min(1).max(256);
const reasonCodeSchema = z.string().trim().min(1).max(128);
export const operationAuditReasonCodeSchema = z.enum([
  'ACTIVE_OPERATION',
  'IDEMPOTENCY_PAYLOAD_MISMATCH',
  'INITIAL_RESULTS_COUNT_MISMATCH',
  'INITIAL_RESULTS_INVALID',
  'INTERRUPTED',
  'LAUNCH_FAILED',
  'OPERATION_FINALIZATION_INCOMPLETE',
  'OPERATION_FINALIZATION_REJECTED',
  'OPERATION_LAUNCH_ATTEMPT_STALE',
  'OPERATION_LAUNCH_FAILURE_REJECTED',
  'OPERATION_LAUNCH_RETRY_REJECTED',
  'OPERATION_REQUEST_INVALID',
  'OPERATION_START_REJECTED',
  'OPERATION_UNAVAILABLE',
  'PROTECTED_RESULT_PAYLOAD_INVALID',
  'STOP_KIND_INVALID',
  'TASK_RESULT_CONFLICT',
  'TASK_RESULT_FIELDS_INVALID',
  'TASK_RESULT_REFINEMENT_CONFLICT',
  'TASK_RESULT_REFINEMENT_FIELDS_INVALID',
  'TASK_RESULT_REFINEMENT_REJECTED',
  'TASK_RESULT_REFINEMENT_VERSIONS_INVALID',
  'TASK_RESULT_REJECTED',
  'UNCONFIRMED_RESULT_RETRY_FORBIDDEN',
  'UPSTREAM_FAILURE',
  'UPSTREAM_OUTCOME_UNKNOWN',
]);
const accessAuditReasonCodeSchema = z.enum([
  'role_change',
  'responsibility_change',
  'security_policy',
  'access_cleanup',
  'employee_request',
  'other',
  'EMPLOYEE_INACTIVE',
  'EMPLOYEE_MISSING',
  'LEGACY_ACCESS_STATE_AMBIGUOUS',
  'MANAGER_ROLE_LOST',
]);
const reportAuditErrorCodeSchema = z.enum([
  'UPSTREAM_FAILURE',
  'REPORT_GENERATION_FAILED',
  'REPORT_STORAGE_FAILED',
  'REPORT_DOWNLOAD_FAILED',
  'REPORT_ARCHIVE_FAILED',
  'REPORT_DELETE_FAILED',
]);
const auditViewReasonCodeSchema = z.enum(['ACCESS_DENIED']);
const systemAuditErrorCodeSchema = z.union([
  operationAuditReasonCodeSchema,
  z.enum(['TASK_RESULT_REFINED']),
]);
const auditSystemComponentSchema = z.enum([
  'operation-state-machine',
  'operation-result-refinement',
]);

export const auditActionSchema = z.enum([
  'operation_create',
  'operation_start',
  'operation_complete',
  'operation_cancel',
  'operation_interrupt',
  'operation_retry',
  'operation_restore',
  'access_grant',
  'access_update',
  'access_revoke',
  'access_auto_revoke',
  'allowed_fields_update',
  'report_export',
  'report_generate',
  'report_store',
  'report_download',
  'report_archive',
  'report_delete',
  'audit_view',
  'audit_retention',
  'system_error',
  'system_recovery',
]);

export const auditOutcomeSchema = z.enum(['success', 'partial', 'failure', 'denied', 'uncertain']);

export const auditObjectTypeSchema = z.enum([
  'operation',
  'operation_attempt',
  'report',
  'user',
  'access',
  'settings',
  'system',
]);

export const auditObjectSchema = z
  .object({
    type: auditObjectTypeSchema,
    id: subjectIdSchema,
    displayName: displayNameSchema,
  })
  .strict();

export const auditActorSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('user'),
      id: bitrixIdSchema,
      displayName: displayNameSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('system'),
      source: z.enum(['internal', 'queue', 'cron', 'recovery', 'retention']),
      displayName: z.literal('Система'),
    })
    .strict(),
]);

const operationDetailsSchema = z
  .object({
    kind: z.literal('operation'),
    reasonCode: reasonCodeSchema.nullable().default(null),
    summary: z
      .object({
        selected: nonNegativeIntegerSchema,
        successful: nonNegativeIntegerSchema,
        failed: nonNegativeIntegerSchema,
        unconfirmed: nonNegativeIntegerSchema.default(0),
        conflicted: nonNegativeIntegerSchema,
        partiallyApplied: nonNegativeIntegerSchema,
        notProcessed: nonNegativeIntegerSchema,
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();

const legacyAccessDetailsSchema = z
  .object({
    kind: z.literal('access'),
    addedPermissions: z.array(permissionSchema).max(10).default([]),
    removedPermissions: z.array(permissionSchema).max(10).default([]),
    addedFieldIds: z.array(fieldIdSchema).max(256).default([]),
    removedFieldIds: z.array(fieldIdSchema).max(256).default([]),
    reasonCode: reasonCodeSchema.nullable().default(null),
  })
  .strict();

const redactedAccessDetailsSchema = z
  .object({
    kind: z.literal('access'),
    version: z.literal(2),
    previousAccessVersion: positiveIntegerSchema.nullable(),
    newAccessVersion: positiveIntegerSchema,
    accessState: z.enum(['active', 'revoked']),
    addedPermissions: z.array(permissionSchema).max(10),
    removedPermissions: z.array(permissionSchema).max(10),
    addedFieldCount: nonNegativeIntegerSchema,
    removedFieldCount: nonNegativeIntegerSchema,
    reasonCode: reasonCodeSchema.nullable(),
  })
  .strict();

const reportDetailsSchema = z
  .object({
    kind: z.literal('report'),
    formats: z
      .array(z.enum(['xlsx', 'csv']))
      .max(2)
      .default([]),
    stage: z
      .enum(['request', 'generate', 'store', 'download', 'archive', 'delete'])
      .nullable()
      .default(null),
    errorCode: reasonCodeSchema.nullable().default(null),
    retryable: z.boolean().nullable().default(null),
  })
  .strict();

const auditViewDetailsSchema = z
  .object({
    kind: z.literal('audit_view'),
    reasonCode: reasonCodeSchema,
  })
  .strict();

const retentionDetailsSchema = z
  .object({
    kind: z.literal('retention'),
    cutoffAt: isoDateTimeSchema,
    deletedCount: nonNegativeIntegerSchema.positive(),
  })
  .strict();

const systemDetailsSchema = z
  .object({
    kind: z.literal('system'),
    component: z.string().trim().min(1).max(128),
    errorCode: reasonCodeSchema,
    retryable: z.boolean(),
  })
  .strict();

export const auditDetailsSchema = z.union([
  operationDetailsSchema,
  legacyAccessDetailsSchema,
  redactedAccessDetailsSchema,
  reportDetailsSchema,
  auditViewDetailsSchema,
  retentionDetailsSchema,
  systemDetailsSchema,
]);

const actionDetailKinds: Record<
  z.infer<typeof auditActionSchema>,
  z.infer<typeof auditDetailsSchema>['kind']
> = {
  operation_create: 'operation',
  operation_start: 'operation',
  operation_complete: 'operation',
  operation_cancel: 'operation',
  operation_interrupt: 'operation',
  operation_retry: 'operation',
  operation_restore: 'operation',
  access_grant: 'access',
  access_update: 'access',
  access_revoke: 'access',
  access_auto_revoke: 'access',
  allowed_fields_update: 'access',
  report_export: 'report',
  report_generate: 'report',
  report_store: 'report',
  report_download: 'report',
  report_archive: 'report',
  report_delete: 'report',
  audit_view: 'audit_view',
  audit_retention: 'retention',
  system_error: 'system',
  system_recovery: 'system',
};

function validateAuditEvent(
  value: {
    action: z.infer<typeof auditActionSchema>;
    outcome: z.infer<typeof auditOutcomeSchema>;
    actor: z.infer<typeof auditActorSchema>;
    details: z.infer<typeof auditDetailsSchema>;
  },
  context: z.RefinementCtx,
): void {
  if (value.details.kind !== actionDetailKinds[value.action]) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['details', 'kind'],
      message: 'Invalid details.',
    });
  }
  if (value.outcome === 'partial' && value.action !== 'operation_complete') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['outcome'],
      message: 'Invalid outcome.',
    });
  }
  if (
    value.action === 'operation_complete' &&
    value.outcome === 'partial' &&
    value.details.kind === 'operation' &&
    value.details.summary === null
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['details', 'summary'],
      message: 'Summary is required.',
    });
  }
  if (value.action === 'audit_view' && value.outcome !== 'denied') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['outcome'],
      message: 'Invalid outcome.',
    });
  }
  if (
    value.action === 'audit_retention' &&
    (value.outcome !== 'success' ||
      value.actor.type !== 'system' ||
      value.actor.source !== 'retention')
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid retention event.' });
  }
  if (value.action === 'system_error' && value.outcome !== 'failure') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['outcome'],
      message: 'Invalid outcome.',
    });
  }
  if (value.action === 'access_auto_revoke' && value.actor.type !== 'system') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['actor'], message: 'Invalid actor.' });
  }
  if (value.outcome === 'denied' && value.actor.type !== 'user') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['actor'], message: 'Invalid actor.' });
  }
}

function validateAuditWriteEvent(
  value: Parameters<typeof validateAuditEvent>[0],
  context: z.RefinementCtx,
): void {
  validateAuditEvent(value, context);
  const details = value.details;
  const allowedCode =
    details.kind === 'operation'
      ? details.reasonCode === null ||
        operationAuditReasonCodeSchema.safeParse(details.reasonCode).success
      : details.kind === 'access'
        ? 'version' in details &&
          details.version === 2 &&
          (details.reasonCode === null ||
            accessAuditReasonCodeSchema.safeParse(details.reasonCode).success)
        : details.kind === 'report'
          ? details.errorCode === null ||
            reportAuditErrorCodeSchema.safeParse(details.errorCode).success
          : details.kind === 'audit_view'
            ? auditViewReasonCodeSchema.safeParse(details.reasonCode).success
            : details.kind === 'system'
              ? systemAuditErrorCodeSchema.safeParse(details.errorCode).success
              : true;
  if (!allowedCode) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [
        'details',
        details.kind === 'report' || details.kind === 'system' ? 'errorCode' : 'reasonCode',
      ],
      message: 'Unknown audit code.',
    });
  }
  if (
    details.kind === 'system' &&
    !auditSystemComponentSchema.safeParse(details.component).success
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['details', 'component'],
      message: 'Unknown audit component.',
    });
  }
}

const knownAuditEventBaseSchema = z
  .object({
    id: z.string().uuid(),
    schemaVersion: z.literal(1),
    occurredAt: isoDateTimeSchema,
    recordedAt: isoDateTimeSchema,
    action: auditActionSchema,
    actor: auditActorSchema,
    subject: auditObjectSchema,
    relatedObjects: z.array(auditObjectSchema).max(8),
    outcome: auditOutcomeSchema,
    correlationId: correlationIdSchema,
    details: auditDetailsSchema,
  })
  .strict();

export const auditEventSchema = knownAuditEventBaseSchema.superRefine(validateAuditEvent);

export const auditWriteEventSchema = knownAuditEventBaseSchema
  .omit({ id: true, schemaVersion: true, recordedAt: true })
  .extend({
    deduplicationScope: z.string().trim().min(1).max(256),
    eventSlot: z.string().trim().min(1).max(64),
  })
  .superRefine(validateAuditWriteEvent);

const unknownAuditEventSchema = z
  .object({
    id: z.string().uuid(),
    schemaVersion: z.number().int().positive(),
    occurredAt: isoDateTimeSchema,
    recordedAt: isoDateTimeSchema,
    action: z.string().trim().min(1).max(128),
    actor: auditActorSchema,
    subject: auditObjectSchema,
    relatedObjects: z.array(auditObjectSchema).max(8),
    outcome: z.string().trim().min(1).max(32),
    correlationId: correlationIdSchema,
    details: z.null(),
  })
  .strict();

export function parseAuditEventForRead(value: unknown): AuditEvent {
  const candidate = z.object({ action: z.string() }).parse(value);
  if (auditActionSchema.safeParse(candidate.action).success) {
    return auditEventSchema.parse(value);
  }

  const object = z.object({ details: z.unknown() }).passthrough().parse(value);
  return unknownAuditEventSchema.parse({ ...object, details: null });
}

export type AuditAction = z.infer<typeof auditActionSchema>;
export type OperationAuditReasonCode = z.infer<typeof operationAuditReasonCodeSchema>;
export type AuditActor = z.infer<typeof auditActorSchema>;
export type AuditEvent = z.infer<typeof auditEventSchema> | z.infer<typeof unknownAuditEventSchema>;
export type AuditObject = z.infer<typeof auditObjectSchema>;
export type AuditWriteEvent = z.infer<typeof auditWriteEventSchema>;
