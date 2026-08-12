import { z } from 'zod';

import {
  bitrixIdSchema,
  correlationIdSchema,
  fieldIdSchema,
  isoDateTimeSchema,
  nonNegativeIntegerSchema,
} from './primitives';

const displayNameSchema = z.string().trim().min(1).max(256);
const subjectIdSchema = z.string().trim().min(1).max(256);
const reasonCodeSchema = z.string().trim().min(1).max(128);

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

const accessDetailsSchema = z
  .object({
    kind: z.literal('access'),
    addedPermissions: z.array(z.string().trim().min(1).max(64)).max(10).default([]),
    removedPermissions: z.array(z.string().trim().min(1).max(64)).max(10).default([]),
    addedFieldIds: z.array(fieldIdSchema).max(256).default([]),
    removedFieldIds: z.array(fieldIdSchema).max(256).default([]),
    reasonCode: reasonCodeSchema.nullable().default(null),
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

export const auditDetailsSchema = z.discriminatedUnion('kind', [
  operationDetailsSchema,
  accessDetailsSchema,
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
  .superRefine(validateAuditEvent);

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
export type AuditActor = z.infer<typeof auditActorSchema>;
export type AuditEvent = z.infer<typeof auditEventSchema> | z.infer<typeof unknownAuditEventSchema>;
export type AuditObject = z.infer<typeof auditObjectSchema>;
export type AuditWriteEvent = z.infer<typeof auditWriteEventSchema>;
