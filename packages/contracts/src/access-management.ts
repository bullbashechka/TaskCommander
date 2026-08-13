import { z } from 'zod';

import { appPermissions, permissionSchema, uniquePermissionsSchema } from './access';
import {
  bitrixIdSchema,
  fieldIdSchema,
  isoDateTimeSchema,
  nonNegativeIntegerSchema,
  positiveIntegerSchema,
} from './primitives';

export const accessManagementLimits = Object.freeze({
  maxRecipients: 100,
  maxFieldPageSize: 100,
  maxSearchResults: 100,
  maxIssuesPerTarget: 16,
  draftTtlSeconds: 24 * 60 * 60,
  preflightTtlSeconds: 10 * 60,
  confirmationTtlSeconds: 5 * 60,
  otherReasonCommentMinLength: 10,
  otherReasonCommentMaxLength: 500,
} as const);

export const accessChangeModeSchema = z.enum([
  'grant',
  'replace_managed',
  'revoke_managed',
  'full_revoke',
  'repair',
]);

export const employmentStateSchema = z.enum(['active', 'inactive', 'unknown']);

export const managedAccessStateSchema = z.enum([
  'active',
  'revoked',
  'quarantined',
  'review_required',
]);

export const accessStateSchema = managedAccessStateSchema;

export const accessChangeReasonCodeSchema = z.enum([
  'role_change',
  'responsibility_change',
  'security_policy',
  'access_cleanup',
  'employee_request',
  'other',
]);

export const accessManagementCommandStateSchema = z.enum([
  'accepted',
  'validating',
  'in_progress',
  'succeeded',
  'partially_succeeded',
  'failed',
  'no_change',
]);

export const accessManagementTargetStateSchema = z.enum([
  'ready',
  'excluded',
  'conflict',
  'applying',
  'applied',
  'failed',
  'no_change',
]);

export const accessManagementPreflightTargetStateSchema = z.enum([
  'ready',
  'excluded',
  'conflict',
  'no_change',
]);

export const accessManagementTargetReasonCodeSchema = z.enum([
  'ADMIN_ACCESS_IMMUTABLE',
  'EMPLOYEE_INACTIVE',
  'EMPLOYMENT_STATE_UNKNOWN',
  'ACCESS_QUARANTINED',
  'ACCESS_REVIEW_REQUIRED',
  'TARGET_ACCESS_CHANGED',
  'ACTOR_ACCESS_CHANGED',
  'PERMISSION_CATALOG_CHANGED',
  'PERMISSION_NOT_DELEGABLE',
  'FIELD_SCOPE_NOT_DELEGABLE',
  'PERMISSION_DEPENDENCY_MISSING',
  'REDUCTION_REASON_REQUIRED',
  'MANAGER_STATUS_REQUIRED',
  'BITRIX_ADMIN_REQUIRED',
  'PREFLIGHT_EXPIRED',
  'CONFIRMATION_EXPIRED',
  'AUDIT_UNAVAILABLE',
  'NOTIFICATION_FAILED',
  'INTERNAL_ERROR',
]);

const accessFingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/i);
const accessVersionSchema = positiveIntegerSchema;
const fieldSetIdSchema = z.string().uuid();
const nullableDisplayTextSchema = z.string().trim().min(1).max(256).nullable();

export const permissionMetadataEntrySchema = z
  .object({
    permission: permissionSchema,
    dependencies: uniquePermissionsSchema,
  })
  .strict();

export const permissionCatalogSchema = z
  .object({
    version: positiveIntegerSchema,
    permissions: z
      .array(permissionMetadataEntrySchema)
      .length(appPermissions.length)
      .refine(
        (entries) => new Set(entries.map((entry) => entry.permission)).size === entries.length,
        { message: 'Permission metadata entries must be unique.' },
      ),
  })
  .strict();

export const accessPermissionCatalog = Object.freeze({
  version: 1,
  permissions: Object.freeze([
    Object.freeze({ permission: 'app_access', dependencies: Object.freeze([]) }),
    Object.freeze({
      permission: 'run_bulk_operations',
      dependencies: Object.freeze(['app_access', 'change_allowed_fields']),
    }),
    Object.freeze({
      permission: 'change_allowed_fields',
      dependencies: Object.freeze(['app_access']),
    }),
    Object.freeze({
      permission: 'retry_operations',
      dependencies: Object.freeze([
        'app_access',
        'run_bulk_operations',
        'change_allowed_fields',
        'view_own_reports',
      ]),
    }),
    Object.freeze({
      permission: 'restore_operations',
      dependencies: Object.freeze([
        'app_access',
        'run_bulk_operations',
        'change_allowed_fields',
        'view_own_reports',
      ]),
    }),
    Object.freeze({
      permission: 'view_own_reports',
      dependencies: Object.freeze(['app_access']),
    }),
    Object.freeze({
      permission: 'view_all_reports',
      dependencies: Object.freeze(['app_access', 'view_own_reports']),
    }),
    Object.freeze({
      permission: 'export_reports',
      dependencies: Object.freeze(['app_access', 'view_own_reports']),
    }),
    Object.freeze({ permission: 'view_audit', dependencies: Object.freeze(['app_access']) }),
    Object.freeze({ permission: 'manage_access', dependencies: Object.freeze(['app_access']) }),
  ]),
} as const);

export const accessFieldSetReferenceSchema = z
  .object({
    fieldSetId: fieldSetIdSchema,
    version: accessVersionSchema,
    count: nonNegativeIntegerSchema,
    fingerprint: accessFingerprintSchema,
  })
  .strict();

export const accessFieldScopeReferenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }).strict(),
  z
    .object({
      kind: z.literal('set'),
      fieldSetId: fieldSetIdSchema,
      version: accessVersionSchema,
      count: nonNegativeIntegerSchema,
      fingerprint: accessFingerprintSchema,
    })
    .strict(),
]);

export const accessFieldSetMembersRequestSchema = z
  .object({
    fieldSetId: fieldSetIdSchema,
    version: accessVersionSchema,
    // A delegated manager may read only the exact current set of this target. Administrators
    // do not need to provide a target identifier.
    targetUserId: bitrixIdSchema.optional(),
    cursor: z.string().regex(/^\d+$/).max(20).optional(),
    limit: positiveIntegerSchema.max(accessManagementLimits.maxFieldPageSize).default(50),
  })
  .strict();

export const accessFieldSetMembersResponseSchema = z
  .object({
    reference: accessFieldSetReferenceSchema,
    fieldIds: z
      .array(fieldIdSchema)
      .max(accessManagementLimits.maxFieldPageSize)
      .refine((fieldIds) => new Set(fieldIds).size === fieldIds.length, {
        message: 'Field IDs in a page must be unique.',
      }),
    nextCursor: z.string().trim().min(1).max(1024).nullable(),
  })
  .strict();

const standardAccessReasonSchema = z
  .object({
    code: z.enum([
      'role_change',
      'responsibility_change',
      'security_policy',
      'access_cleanup',
      'employee_request',
    ]),
  })
  .strict();

const otherAccessReasonSchema = z
  .object({
    code: z.literal('other'),
    comment: z
      .string()
      .trim()
      .min(accessManagementLimits.otherReasonCommentMinLength)
      .max(accessManagementLimits.otherReasonCommentMaxLength),
  })
  .strict();

export const accessChangeReasonSchema = z.discriminatedUnion('code', [
  standardAccessReasonSchema,
  otherAccessReasonSchema,
]);

export const accessEmployeeSummarySchema = z
  .object({
    userId: bitrixIdSchema,
    displayName: z.string().trim().min(1).max(256),
    jobTitle: nullableDisplayTextSchema,
    departmentName: nullableDisplayTextSchema,
    avatarUrl: z.string().url().nullable(),
    employmentState: employmentStateSchema,
    accessState: managedAccessStateSchema,
    accessVersion: accessVersionSchema.nullable(),
    permissionCount: nonNegativeIntegerSchema.max(appPermissions.length),
    fieldScope: accessFieldScopeReferenceSchema.nullable(),
    isManager: z.boolean(),
    isBitrixAdmin: z.boolean(),
    isSelf: z.boolean().default(false),
    canManage: z.boolean().default(false),
  })
  .strict();

export const accessEmployeeSearchRequestSchema = z
  .object({
    q: z.string().trim().max(256).default(''),
    status: z.enum(['all', 'active', 'none']).default('all'),
    cursor: z.string().trim().min(1).max(128).optional(),
    pageSize: positiveIntegerSchema.max(50).default(50),
    departmentId: bitrixIdSchema.optional(),
    includeInactive: z.boolean().default(true),
  })
  .strict();

export const accessEmployeeSearchResponseSchema = z
  .object({
    checkedAt: isoDateTimeSchema,
    employees: z.array(accessEmployeeSummarySchema).max(accessManagementLimits.maxSearchResults),
    nextCursor: z.string().trim().min(1).max(1024).nullable(),
  })
  .strict();

export const employeeAccessSnapshotSchema = z
  .object({
    settingsVersion: accessVersionSchema.nullable(),
    permissionCatalogVersion: accessVersionSchema,
    permissions: uniquePermissionsSchema,
    fieldScope: accessFieldScopeReferenceSchema,
    grantedAt: isoDateTimeSchema.nullable(),
    updatedAt: isoDateTimeSchema.nullable(),
    grantedByUserId: bitrixIdSchema.nullable(),
  })
  .strict();

export const accessManagementCapabilitiesSchema = z
  .object({
    canManage: z.boolean(),
    availableModes: z.array(accessChangeModeSchema).max(5),
    delegablePermissions: uniquePermissionsSchema,
    delegableFieldScope: accessFieldScopeReferenceSchema,
    blockingReasonCode: accessManagementTargetReasonCodeSchema.nullable(),
  })
  .strict();

export const accessEmployeeProfileSchema = z
  .object({
    employee: accessEmployeeSummarySchema,
    access: employeeAccessSnapshotSchema,
    capabilities: accessManagementCapabilitiesSchema,
    checkedAt: isoDateTimeSchema,
  })
  .strict();

export const accessManagementDraftTargetSchema = z
  .object({
    userId: bitrixIdSchema,
    baseAccessVersion: accessVersionSchema.nullable(),
  })
  .strict();

const uniqueDraftTargetsSchema = z
  .array(accessManagementDraftTargetSchema)
  .min(1)
  .max(accessManagementLimits.maxRecipients)
  .refine((targets) => new Set(targets.map((target) => target.userId)).size === targets.length, {
    message: 'Draft targets must be unique.',
  });

export const accessManagementDraftIntentSchema = z
  .object({
    subjectIds: z
      .array(bitrixIdSchema)
      .min(1)
      .max(accessManagementLimits.maxRecipients)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: 'Draft subjects must be unique.',
      }),
    subjectVersions: z.record(bitrixIdSchema, accessVersionSchema.nullable()),
    draftRevision: nonNegativeIntegerSchema,
    mode: accessChangeModeSchema,
    permissions: uniquePermissionsSchema,
    fieldIds: z.array(fieldIdSchema).refine((ids) => new Set(ids).size === ids.length, {
      message: 'Draft fields must be unique.',
    }),
    reason: accessChangeReasonSchema.nullable(),
    permissionCatalogVersion: accessVersionSchema,
    actorAccessVersion: accessVersionSchema,
  })
  .strict()
  .refine(
    (draft) =>
      Object.keys(draft.subjectVersions).length === draft.subjectIds.length &&
      draft.subjectIds.every((id) => Object.hasOwn(draft.subjectVersions, id)),
    { message: 'Every draft subject must have exactly one base version.' },
  );

export const accessManagementDraftSaveResponseSchema = z
  .object({
    draftId: z.string().uuid(),
    revision: accessVersionSchema,
    expiresAt: isoDateTimeSchema,
  })
  .strict();

export const accessManagementDraftInputSchema = z
  .object({
    mode: accessChangeModeSchema,
    targets: uniqueDraftTargetsSchema,
    permissions: uniquePermissionsSchema,
    fieldScope: accessFieldScopeReferenceSchema.nullable(),
    // Preflight decides whether a reason is mandatory after it calculates the effective delta.
    // Additive and no-op changes deliberately do not force the user to invent a reason.
    reason: accessChangeReasonSchema.nullable(),
    permissionCatalogVersion: accessVersionSchema,
    actorAccessVersion: accessVersionSchema,
  })
  .strict();

export const accessManagementDraftSchema = accessManagementDraftInputSchema
  .extend({
    draftId: z.string().uuid(),
    revision: accessVersionSchema,
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    expiresAt: isoDateTimeSchema,
    ttlSeconds: z.literal(accessManagementLimits.draftTtlSeconds),
  })
  .strict();

export const accessPermissionDeltaSchema = z
  .object({
    added: uniquePermissionsSchema,
    removed: uniquePermissionsSchema,
  })
  .strict();

export const redactedFieldScopeDeltaSchema = z
  .object({
    before: accessFieldScopeReferenceSchema,
    after: accessFieldScopeReferenceSchema,
    addedCount: nonNegativeIntegerSchema,
    removedCount: nonNegativeIntegerSchema,
  })
  .strict();

export const redactedAccessDeltaSchema = z
  .object({
    permissions: accessPermissionDeltaSchema,
    fields: redactedFieldScopeDeltaSchema,
  })
  .strict();

export const accessManagementDiffSchema = redactedAccessDeltaSchema;

export const accessManagementIssueSchema = z
  .object({
    code: accessManagementTargetReasonCodeSchema,
    message: z.string().trim().min(1).max(512),
  })
  .strict();

export const accessManagementPreflightTargetSchema = z
  .object({
    employee: accessEmployeeSummarySchema,
    state: accessManagementPreflightTargetStateSchema,
    baseAccessVersion: accessVersionSchema.nullable(),
    checkedAccessVersion: accessVersionSchema.nullable(),
    requestedDelta: redactedAccessDeltaSchema,
    automaticDelta: redactedAccessDeltaSchema,
    issues: z
      .array(accessManagementIssueSchema)
      .max(accessManagementLimits.maxIssuesPerTarget),
  })
  .strict();

export const accessManagementSummarySchema = z
  .object({
    total: nonNegativeIntegerSchema.max(accessManagementLimits.maxRecipients),
    ready: nonNegativeIntegerSchema.max(accessManagementLimits.maxRecipients),
    excluded: nonNegativeIntegerSchema.max(accessManagementLimits.maxRecipients),
    conflicts: nonNegativeIntegerSchema.max(accessManagementLimits.maxRecipients),
    applied: nonNegativeIntegerSchema.max(accessManagementLimits.maxRecipients),
    failed: nonNegativeIntegerSchema.max(accessManagementLimits.maxRecipients),
    noChange: nonNegativeIntegerSchema.max(accessManagementLimits.maxRecipients),
  })
  .strict();

export const accessConfirmationRequirementsSchema = z
  .object({
    required: z.boolean(),
    tokenRequired: z.boolean(),
    acknowledgementText: z.string().trim().min(1).max(500),
    recipientCount: nonNegativeIntegerSchema.max(accessManagementLimits.maxRecipients),
    validForSeconds: z.literal(accessManagementLimits.confirmationTtlSeconds),
  })
  .strict();

export const accessManagementPreflightSchema = z
  .object({
    preflightId: z.string().uuid(),
    draftId: z.string().uuid(),
    draftRevision: accessVersionSchema,
    mode: accessChangeModeSchema,
    permissionCatalogVersion: accessVersionSchema,
    actorAccessVersion: accessVersionSchema,
    checkedAt: isoDateTimeSchema,
    expiresAt: isoDateTimeSchema,
    ttlSeconds: z.literal(accessManagementLimits.preflightTtlSeconds),
    summary: accessManagementSummarySchema,
    targets: z
      .array(accessManagementPreflightTargetSchema)
      .min(1)
      .max(accessManagementLimits.maxRecipients),
    confirmation: accessConfirmationRequirementsSchema,
  })
  .strict();

export const accessManagementConfirmationRequestSchema = z
  .object({
    preflightId: z.string().uuid(),
    draftRevision: accessVersionSchema,
    confirmed: z.literal(true),
  })
  .strict();

export const accessManagementConfirmationSchema = z
  .object({
    confirmationId: z.string().uuid(),
    preflightId: z.string().uuid(),
    draftRevision: accessVersionSchema,
    token: z.string().min(32).max(2048).optional(),
    issuedAt: isoDateTimeSchema,
    expiresAt: isoDateTimeSchema,
    ttlSeconds: z.literal(accessManagementLimits.confirmationTtlSeconds),
  })
  .strict();

export const accessManagementCommandRequestSchema = z
  .object({
    commandId: z.string().uuid(),
    preflightId: z.string().uuid(),
    confirmationId: z.string().uuid().optional(),
    confirmationToken: z.string().min(32).max(2048).optional(),
  })
  .strict()
  .refine(
    (command) =>
      (command.confirmationId === undefined) === (command.confirmationToken === undefined),
    { message: 'Confirmation ID and token must be supplied together.' },
  );

export const accessManagementCommandSchema = z
  .object({
    commandId: z.string().uuid(),
    preflightId: z.string().uuid(),
    confirmationId: z.string().uuid().optional(),
    confirmationToken: z.string().min(32).max(2048).optional(),
  })
  .strict()
  .refine(
    (command) =>
      (command.confirmationId === undefined) === (command.confirmationToken === undefined),
    { message: 'Confirmation ID and token must be supplied together.' },
  );

export const accessNotificationStateSchema = z.enum([
  'not_required',
  'queued',
  'sent',
  'failed',
]);

export const accessManagementTargetReceiptSchema = z
  .object({
    userId: bitrixIdSchema,
    displayName: z.string().trim().min(1).max(256),
    state: accessManagementTargetStateSchema,
    beforeAccessVersion: accessVersionSchema.nullable(),
    afterAccessVersion: accessVersionSchema.nullable(),
    appliedDelta: redactedAccessDeltaSchema,
    reasonCode: accessManagementTargetReasonCodeSchema.nullable(),
    notificationState: accessNotificationStateSchema,
  })
  .strict();

export const accessManagementCommandReceiptSchema = z
  .object({
    commandId: z.string().uuid(),
    preflightId: z.string().uuid(),
    state: accessManagementCommandStateSchema,
    mode: accessChangeModeSchema,
    acceptedAt: isoDateTimeSchema,
    startedAt: isoDateTimeSchema.nullable(),
    completedAt: isoDateTimeSchema.nullable(),
    summary: accessManagementSummarySchema,
    targets: z
      .array(accessManagementTargetReceiptSchema)
      .min(1)
      .max(accessManagementLimits.maxRecipients),
  })
  .strict();

export type AccessChangeMode = z.infer<typeof accessChangeModeSchema>;
export type AccessChangeReason = z.infer<typeof accessChangeReasonSchema>;
export type AccessEmployeeSearchRequest = z.infer<typeof accessEmployeeSearchRequestSchema>;
export type AccessEmployeeSearchResponse = z.infer<typeof accessEmployeeSearchResponseSchema>;
export type AccessEmployeeProfile = z.infer<typeof accessEmployeeProfileSchema>;
export type AccessEmployeeSummary = z.infer<typeof accessEmployeeSummarySchema>;
export type AccessFieldScopeReference = z.infer<typeof accessFieldScopeReferenceSchema>;
export type AccessManagementCommand = z.infer<typeof accessManagementCommandSchema>;
export type AccessManagementCommandRequest = z.infer<
  typeof accessManagementCommandRequestSchema
>;
export type AccessManagementCommandReceipt = z.infer<
  typeof accessManagementCommandReceiptSchema
>;
export type AccessManagementConfirmation = z.infer<typeof accessManagementConfirmationSchema>;
export type AccessManagementConfirmationRequest = z.infer<
  typeof accessManagementConfirmationRequestSchema
>;
export type AccessManagementDiff = z.infer<typeof accessManagementDiffSchema>;
export type AccessManagementDraft = z.infer<typeof accessManagementDraftSchema>;
export type AccessManagementDraftInput = z.infer<typeof accessManagementDraftInputSchema>;
export type AccessManagementDraftIntent = z.infer<typeof accessManagementDraftIntentSchema>;
export type AccessManagementDraftSaveResponse = z.infer<
  typeof accessManagementDraftSaveResponseSchema
>;
export type AccessManagementPreflight = z.infer<typeof accessManagementPreflightSchema>;
export type AccessManagementCommandState = z.infer<typeof accessManagementCommandStateSchema>;
export type AccessManagementTargetState = z.infer<typeof accessManagementTargetStateSchema>;
export type AccessPermissionCatalog = z.infer<typeof permissionCatalogSchema>;
export type AccessFieldSetMembersRequest = z.infer<typeof accessFieldSetMembersRequestSchema>;
export type AccessFieldSetMembersResponse = z.infer<typeof accessFieldSetMembersResponseSchema>;
export type EmploymentState = z.infer<typeof employmentStateSchema>;
export type ManagedAccessState = z.infer<typeof managedAccessStateSchema>;
