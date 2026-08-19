import { describe, expect, it } from 'vitest';

import { AccessPolicyError, evaluateAccessChange } from '../src/access-management/policy';

const base = {
  mode: 'replace_managed' as const,
  actorId: '20',
  actorIsAdministrator: false,
  actorPermissions: [
    'app_access',
    'change_allowed_fields',
    'run_bulk_operations',
    'view_own_reports',
    'manage_access',
  ] as const,
  actorFieldScope: { kind: 'subset' as const, fieldIds: ['title', 'deadline'] },
  targetId: '10',
  targetIsAdministrator: false,
  targetIsActive: true,
  currentPermissions: ['app_access'] as const,
  currentFieldIds: [] as const,
  currentAccessState: 'active' as const,
  requestedPermissions: ['run_bulk_operations'] as const,
  requestedFieldIds: ['title'] as const,
  hasReductionReason: false,
};

describe('access management policy', () => {
  it('adds dependencies explicitly and preserves canonical ordering', () => {
    expect(evaluateAccessChange(base)).toMatchObject({
      desiredPermissions: ['app_access', 'run_bulk_operations', 'change_allowed_fields'],
      automaticPermissions: ['app_access', 'change_allowed_fields'],
      desiredFieldIds: ['title'],
    });
  });

  it('does not let a manager grant manage_access', () => {
    expect(() =>
      evaluateAccessChange({ ...base, requestedPermissions: ['manage_access'] }),
    ).toThrowError(
      expect.objectContaining<Partial<AccessPolicyError>>({
        code: 'manage_access_requires_administrator',
      }),
    );
  });

  it('lets a manager explicitly remove manage_access already inside their own scope', () => {
    expect(
      evaluateAccessChange({
        ...base,
        mode: 'revoke_managed',
        currentPermissions: ['app_access', 'manage_access'],
        requestedPermissions: ['manage_access'],
        requestedFieldIds: [],
        hasReductionReason: true,
      }),
    ).toMatchObject({ desiredPermissions: ['app_access'] });
  });

  it('requires a reason for any effective reduction', () => {
    expect(() =>
      evaluateAccessChange({
        ...base,
        currentPermissions: ['app_access', 'change_allowed_fields'],
        currentFieldIds: ['title'],
        requestedPermissions: ['app_access'],
        requestedFieldIds: [],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<AccessPolicyError>>({ code: 'reason_required' }),
    );
  });

  it('preserves permissions and fields outside a delegated manager scope', () => {
    const result = evaluateAccessChange({
      ...base,
      currentPermissions: ['app_access', 'change_allowed_fields', 'view_audit'],
      currentFieldIds: ['title', 'private_field'],
      requestedPermissions: ['app_access', 'change_allowed_fields'],
      requestedFieldIds: ['deadline'],
      hasReductionReason: true,
    });
    expect(result.desiredPermissions).toContain('view_audit');
    expect(result.desiredFieldIds).toEqual(['deadline', 'private_field']);
  });

  it('requires explicit full revoke to remove app_access', () => {
    expect(
      evaluateAccessChange({
        ...base,
        actorIsAdministrator: true,
        actorPermissions: [],
        actorFieldScope: { kind: 'all' },
        mode: 'full_revoke',
        hasReductionReason: true,
      }),
    ).toMatchObject({ desiredPermissions: [], desiredFieldIds: [] });
  });

  it('allows a manager full revoke only when the complete assignment is in their scope', () => {
    expect(
      evaluateAccessChange({
        ...base,
        mode: 'full_revoke',
        currentPermissions: ['app_access', 'view_own_reports'],
        currentFieldIds: ['title'],
        requestedPermissions: [],
        requestedFieldIds: [],
        hasReductionReason: true,
      }),
    ).toMatchObject({ desiredPermissions: [], desiredFieldIds: [] });

    expect(() =>
      evaluateAccessChange({
        ...base,
        mode: 'full_revoke',
        currentPermissions: ['app_access', 'view_audit'],
        requestedPermissions: [],
        requestedFieldIds: [],
        hasReductionReason: true,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<AccessPolicyError>>({
        code: 'permission_outside_actor_scope',
      }),
    );
  });

  it('reports dependent permissions removed by reverse closure as automatic', () => {
    expect(
      evaluateAccessChange({
        ...base,
        mode: 'revoke_managed',
        currentPermissions: ['app_access', 'change_allowed_fields', 'run_bulk_operations'],
        currentFieldIds: ['title'],
        requestedPermissions: ['change_allowed_fields'],
        requestedFieldIds: ['title'],
        hasReductionReason: true,
      }),
    ).toMatchObject({
      desiredPermissions: ['app_access'],
      removedPermissions: ['run_bulk_operations', 'change_allowed_fields'],
      automaticRemovedPermissions: ['run_bulk_operations'],
    });
  });

  it('limits repair to administrators and inconsistent states', () => {
    expect(() => evaluateAccessChange({ ...base, mode: 'repair' })).toThrowError(
      expect.objectContaining<Partial<AccessPolicyError>>({
        code: 'repair_requires_administrator',
      }),
    );
    expect(() =>
      evaluateAccessChange({ ...base, mode: 'repair', actorIsAdministrator: true }),
    ).toThrowError(
      expect.objectContaining<Partial<AccessPolicyError>>({
        code: 'repair_requires_inconsistent_access',
      }),
    );
    expect(
      evaluateAccessChange({
        ...base,
        mode: 'repair',
        actorIsAdministrator: true,
        actorFieldScope: { kind: 'all' },
        currentAccessState: 'quarantined',
      }),
    ).toMatchObject({ desiredFieldIds: ['title'] });
  });

  it('keeps base access when a delegated manager revokes every manageable permission', () => {
    expect(
      evaluateAccessChange({
        ...base,
        mode: 'revoke_managed',
        currentPermissions: ['app_access', 'view_own_reports'],
        requestedPermissions: ['app_access', 'view_own_reports'],
        requestedFieldIds: [],
        hasReductionReason: true,
      }),
    ).toMatchObject({ desiredPermissions: ['app_access'] });
  });

  it('preserves the field permission needed by fields outside the manager scope', () => {
    expect(
      evaluateAccessChange({
        ...base,
        mode: 'revoke_managed',
        currentPermissions: ['app_access', 'change_allowed_fields'],
        currentFieldIds: ['private_field'],
        requestedPermissions: ['app_access', 'change_allowed_fields'],
        requestedFieldIds: ['title'],
        hasReductionReason: true,
      }),
    ).toMatchObject({
      desiredPermissions: ['app_access', 'change_allowed_fields'],
      desiredFieldIds: ['private_field'],
    });
  });

  it('revokes only the requested part of the actor scope', () => {
    expect(
      evaluateAccessChange({
        ...base,
        actorPermissions: [...base.actorPermissions, 'export_reports'],
        mode: 'revoke_managed',
        currentPermissions: ['app_access', 'view_own_reports', 'export_reports'],
        requestedPermissions: ['export_reports'],
        requestedFieldIds: [],
        hasReductionReason: true,
      }),
    ).toMatchObject({ desiredPermissions: ['app_access', 'view_own_reports'] });
  });
});
