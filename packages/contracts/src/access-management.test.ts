import { describe, expect, it } from 'vitest';

import {
  accessChangeModeSchema,
  accessChangeReasonSchema,
  accessEmployeeSearchRequestSchema,
  accessFieldScopeReferenceSchema,
  accessFieldSetMembersResponseSchema,
  accessManagementCommandReceiptSchema,
  accessManagementCommandRequestSchema,
  accessManagementCommandSchema,
  accessManagementCommandStateSchema,
  accessManagementDraftInputSchema,
  accessManagementDraftIntentSchema,
  accessManagementLimits,
  accessManagementPreflightSchema,
  accessManagementTargetStateSchema,
  accessPermissionCatalog,
  employmentStateSchema,
  managedAccessStateSchema,
  permissionCatalogSchema,
} from './access-management';

const fieldScope = {
  kind: 'set' as const,
  fieldSetId: '123e4567-e89b-42d3-a456-426614174000',
  version: 2,
  count: 3,
  fingerprint: 'a'.repeat(64),
};

const emptyDelta = {
  permissions: { added: [], removed: [] },
  fields: {
    before: { kind: 'all' as const },
    after: { kind: 'all' as const },
    addedCount: 0,
    removedCount: 0,
  },
};

describe('access-management contracts', () => {
  it('exposes the approved modes and lifecycle states', () => {
    expect(
      ['grant', 'replace_managed', 'revoke_managed', 'full_revoke', 'repair'].every(
        (mode) => accessChangeModeSchema.safeParse(mode).success,
      ),
    ).toBe(true);
    expect(
      ['active', 'inactive', 'unknown'].every(
        (state) => employmentStateSchema.safeParse(state).success,
      ),
    ).toBe(true);
    expect(
      ['active', 'revoked', 'quarantined', 'review_required'].every(
        (state) => managedAccessStateSchema.safeParse(state).success,
      ),
    ).toBe(true);
    expect(
      [
        'accepted',
        'validating',
        'in_progress',
        'succeeded',
        'partially_succeeded',
        'failed',
        'no_change',
      ].every((state) => accessManagementCommandStateSchema.safeParse(state).success),
    ).toBe(true);
    expect(
      ['ready', 'excluded', 'conflict', 'applying', 'applied', 'failed', 'no_change'].every(
        (state) => accessManagementTargetStateSchema.safeParse(state).success,
      ),
    ).toBe(true);
  });

  it('keeps employee-search wire limits aligned with Bitrix and database identifiers', () => {
    expect(accessEmployeeSearchRequestSchema.safeParse({
      q: '',
      status: 'all',
      pageSize: 50,
      departmentId: '1'.repeat(32),
    }).success).toBe(true);
    expect(accessEmployeeSearchRequestSchema.safeParse({ q: '', pageSize: 51 }).success).toBe(false);
    expect(accessEmployeeSearchRequestSchema.safeParse({
      q: '',
      departmentId: '1'.repeat(33),
    }).success).toBe(false);
  });

  it('publishes a valid versioned permission catalogue with the approved dependencies', () => {
    expect(permissionCatalogSchema.safeParse(accessPermissionCatalog).success).toBe(true);
    expect(
      accessPermissionCatalog.permissions.find(
        ({ permission }) => permission === 'run_bulk_operations',
      )?.dependencies,
    ).toEqual(['app_access', 'change_allowed_fields']);
    expect(
      accessPermissionCatalog.permissions.find(
        ({ permission }) => permission === 'restore_operations',
      )?.dependencies,
    ).toEqual([
      'app_access',
      'run_bulk_operations',
      'change_allowed_fields',
      'view_own_reports',
    ]);
  });

  it('uses immutable field-set references instead of exposing field IDs in summaries', () => {
    expect(accessFieldScopeReferenceSchema.safeParse(fieldScope).success).toBe(true);
    expect(
      accessFieldScopeReferenceSchema.safeParse({ ...fieldScope, fieldIds: ['deadline'] }).success,
    ).toBe(false);
    expect(accessFieldScopeReferenceSchema.safeParse({ ...fieldScope, count: 10_000 }).success).toBe(
      true,
    );
    expect(
      accessFieldSetMembersResponseSchema.safeParse({
        reference: {
          fieldSetId: fieldScope.fieldSetId,
          version: fieldScope.version,
          count: 10_000,
          fingerprint: fieldScope.fingerprint,
        },
        fieldIds: Array.from(
          { length: accessManagementLimits.maxFieldPageSize + 1 },
          (_, index) => `field_${index}`,
        ),
        nextCursor: null,
      }).success,
    ).toBe(false);
  });

  it('requires a bounded explanation only for the other reason', () => {
    expect(
      accessChangeReasonSchema.safeParse({ code: 'role_change', comment: 'not allowed' }).success,
    ).toBe(false);
    expect(accessChangeReasonSchema.safeParse({ code: 'other', comment: 'too short' }).success).toBe(
      false,
    );
    expect(
      accessChangeReasonSchema.safeParse({
        code: 'other',
        comment: 'Пояснение причины изменения доступа',
      }).success,
    ).toBe(true);
  });

  it('rejects duplicate and oversized draft recipient sets', () => {
    const draft = {
      mode: 'grant',
      targets: [{ userId: '42', baseAccessVersion: 1 }],
      permissions: ['app_access'],
      fieldScope,
      reason: null,
      permissionCatalogVersion: 1,
      actorAccessVersion: 4,
    };

    expect(accessManagementDraftInputSchema.safeParse(draft).success).toBe(true);
    expect(
      accessManagementDraftInputSchema.safeParse({
        ...draft,
        mode: 'replace_managed',
        reason: { code: 'role_change' },
      }).success,
    ).toBe(true);
    expect(
      accessManagementDraftInputSchema.safeParse({
        ...draft,
        targets: [...draft.targets, ...draft.targets],
      }).success,
    ).toBe(false);
    expect(
      accessManagementDraftInputSchema.safeParse({
        ...draft,
        targets: Array.from(
          { length: accessManagementLimits.maxRecipients + 1 },
          (_, index) => ({ userId: String(index + 1), baseAccessVersion: null }),
        ),
      }).success,
    ).toBe(false);
  });

  it('requires an exact version map for the UI draft intent without a field-count cap', () => {
    const intent = {
      subjectIds: ['42'],
      subjectVersions: { '42': null },
      draftRevision: 0,
      mode: 'grant',
      permissions: ['app_access'],
      fieldIds: Array.from({ length: 300 }, (_, index) => `field_${index}`),
      reason: null,
      permissionCatalogVersion: 1,
      actorAccessVersion: 1,
    };
    expect(accessManagementDraftIntentSchema.safeParse(intent).success).toBe(true);
    expect(
      accessManagementDraftIntentSchema.safeParse({
        ...intent,
        subjectIds: ['42', '43'],
      }).success,
    ).toBe(false);
  });

  it('accepts only the minimal preflight-bound command shape', () => {
    const command = {
      commandId: '123e4567-e89b-42d3-a456-426614174000',
      preflightId: '223e4567-e89b-42d3-a456-426614174000',
      confirmationId: '323e4567-e89b-42d3-a456-426614174000',
      confirmationToken: 'x'.repeat(32),
    };

    expect(accessManagementCommandSchema.safeParse(command).success).toBe(true);
    expect(
      accessManagementCommandSchema.safeParse({ ...command, userIds: ['42'] }).success,
    ).toBe(false);
  });

  it('binds an execution token to an explicit confirmation identifier', () => {
    const command = {
      commandId: '123e4567-e89b-42d3-a456-426614174000',
      preflightId: '223e4567-e89b-42d3-a456-426614174000',
      confirmationId: '323e4567-e89b-42d3-a456-426614174000',
      confirmationToken: 'x'.repeat(32),
    };
    expect(accessManagementCommandRequestSchema.safeParse(command).success).toBe(true);
    expect(
      accessManagementCommandRequestSchema.safeParse({
        ...command,
        confirmationId: undefined,
      }).success,
    ).toBe(false);
  });

  it('pins preflight versions, lifetimes, redacted deltas, and confirmation requirements', () => {
    expect(
      accessManagementPreflightSchema.safeParse({
        preflightId: '223e4567-e89b-42d3-a456-426614174000',
        draftId: '323e4567-e89b-42d3-a456-426614174000',
        draftRevision: 3,
        mode: 'grant',
        permissionCatalogVersion: 1,
        actorAccessVersion: 4,
        checkedAt: '2026-08-13T10:00:00+05:00',
        expiresAt: '2026-08-13T10:10:00+05:00',
        ttlSeconds: accessManagementLimits.preflightTtlSeconds,
        summary: {
          total: 1,
          ready: 1,
          excluded: 0,
          conflicts: 0,
          applied: 0,
          failed: 0,
          noChange: 0,
        },
        targets: [
          {
            employee: {
              userId: '42',
              displayName: 'Анна Смирнова',
              jobTitle: 'Руководитель проектов',
              departmentName: 'Маркетинг',
              avatarUrl: null,
              employmentState: 'active',
              accessState: 'active',
              accessVersion: 1,
              permissionCount: 1,
              fieldScope,
              isManager: true,
              isBitrixAdmin: false,
            },
            state: 'ready',
            baseAccessVersion: 1,
            checkedAccessVersion: 1,
            requestedDelta: emptyDelta,
            automaticDelta: emptyDelta,
            issues: [],
          },
        ],
        confirmation: {
          required: true,
          tokenRequired: true,
          acknowledgementText: 'Подтверждаю изменение доступа для 1 сотрудника.',
          recipientCount: 1,
          validForSeconds: accessManagementLimits.confirmationTtlSeconds,
        },
      }).success,
    ).toBe(true);
  });

  it('supports safe per-target command receipts without raw field values', () => {
    expect(
      accessManagementCommandReceiptSchema.safeParse({
        commandId: '123e4567-e89b-42d3-a456-426614174000',
        preflightId: '223e4567-e89b-42d3-a456-426614174000',
        state: 'partially_succeeded',
        mode: 'replace_managed',
        acceptedAt: '2026-08-13T10:00:00+05:00',
        startedAt: '2026-08-13T10:00:01+05:00',
        completedAt: '2026-08-13T10:00:02+05:00',
        summary: {
          total: 2,
          ready: 0,
          excluded: 0,
          conflicts: 1,
          applied: 1,
          failed: 0,
          noChange: 0,
        },
        targets: [
          {
            userId: '42',
            displayName: 'Анна Смирнова',
            state: 'applied',
            beforeAccessVersion: 1,
            afterAccessVersion: 2,
            appliedDelta: emptyDelta,
            reasonCode: null,
            notificationState: 'queued',
          },
          {
            userId: '43',
            displayName: 'Иван Петров',
            state: 'conflict',
            beforeAccessVersion: 3,
            afterAccessVersion: 3,
            appliedDelta: emptyDelta,
            reasonCode: 'TARGET_ACCESS_CHANGED',
            notificationState: 'not_required',
          },
        ],
      }).success,
    ).toBe(true);
  });
});
