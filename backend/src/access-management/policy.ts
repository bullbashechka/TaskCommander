import { appPermissions, type Permission } from '@task-commander/contracts';

export type AccessChangeMode =
  | 'grant'
  | 'replace_managed'
  | 'revoke_managed'
  | 'full_revoke'
  | 'repair';

export const permissionDependencies: Readonly<Record<Permission, readonly Permission[]>> =
  Object.freeze({
    app_access: [],
    run_bulk_operations: ['app_access', 'change_allowed_fields'],
    change_allowed_fields: ['app_access'],
    retry_operations: [
      'app_access',
      'run_bulk_operations',
      'change_allowed_fields',
      'view_own_reports',
    ],
    restore_operations: [
      'app_access',
      'run_bulk_operations',
      'change_allowed_fields',
      'view_own_reports',
    ],
    view_own_reports: ['app_access'],
    view_all_reports: ['app_access', 'view_own_reports'],
    export_reports: ['app_access', 'view_own_reports'],
    view_audit: ['app_access'],
    manage_access: ['app_access'],
  });

const permissionOrder = new Map(appPermissions.map((permission, index) => [permission, index]));
const sensitivePermissions = new Set<Permission>([
  'manage_access',
  'view_audit',
  'view_all_reports',
]);

function ordered(values: Iterable<Permission>): Permission[] {
  return [...new Set(values)].sort(
    (left, right) =>
      (permissionOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (permissionOrder.get(right) ?? Number.MAX_SAFE_INTEGER),
  );
}

function orderedFields(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function closePermissionDependencies(requested: readonly Permission[]): {
  permissions: Permission[];
  automaticPermissions: Permission[];
} {
  const requestedSet = new Set(requested);
  const closure = new Set(requested);
  const pending = [...requested];
  while (pending.length > 0) {
    const permission = pending.pop();
    if (!permission) continue;
    for (const dependency of permissionDependencies[permission]) {
      if (closure.has(dependency)) continue;
      closure.add(dependency);
      pending.push(dependency);
    }
  }
  return {
    permissions: ordered(closure),
    automaticPermissions: ordered([...closure].filter((permission) => !requestedSet.has(permission))),
  };
}

export type AccessPolicyFailure =
  | 'manager_cannot_manage_self'
  | 'administrator_target_is_read_only'
  | 'inactive_target'
  | 'manage_access_requires_administrator'
  | 'permission_outside_actor_scope'
  | 'field_outside_actor_scope'
  | 'app_access_requires_full_revoke'
  | 'allowed_fields_require_permission'
  | 'repair_requires_administrator'
  | 'repair_requires_inconsistent_access'
  | 'reason_required';

export class AccessPolicyError extends Error {
  public constructor(public readonly code: AccessPolicyFailure) {
    super(code);
  }
}

export interface AccessPolicyInput {
  mode: AccessChangeMode;
  actorId: string;
  actorIsAdministrator: boolean;
  actorPermissions: readonly Permission[];
  actorFieldScope: { kind: 'all' } | { kind: 'subset'; fieldIds: readonly string[] };
  targetId: string;
  targetIsAdministrator: boolean;
  targetIsActive: boolean;
  currentPermissions: readonly Permission[];
  currentFieldIds: readonly string[];
  currentAccessState: 'active' | 'revoked' | 'quarantined' | 'review_required';
  requestedPermissions: readonly Permission[];
  requestedFieldIds: readonly string[];
  hasReductionReason: boolean;
}

export interface AccessPolicyResult {
  desiredPermissions: Permission[];
  desiredFieldIds: string[];
  requestedPermissions: Permission[];
  automaticPermissions: Permission[];
  automaticAddedPermissions: Permission[];
  automaticRemovedPermissions: Permission[];
  addedPermissions: Permission[];
  removedPermissions: Permission[];
  addedFieldIds: string[];
  removedFieldIds: string[];
  requiresSensitiveConfirmation: boolean;
  noChange: boolean;
}

export function evaluateAccessChange(input: AccessPolicyInput): AccessPolicyResult {
  if (input.actorId === input.targetId) throw new AccessPolicyError('manager_cannot_manage_self');
  if (input.targetIsAdministrator) {
    throw new AccessPolicyError('administrator_target_is_read_only');
  }
  if (!input.targetIsActive) throw new AccessPolicyError('inactive_target');
  if (input.mode === 'repair' && !input.actorIsAdministrator) {
    throw new AccessPolicyError('repair_requires_administrator');
  }
  if (
    input.mode === 'repair' &&
    input.currentAccessState !== 'quarantined' &&
    input.currentAccessState !== 'review_required'
  ) {
    throw new AccessPolicyError('repair_requires_inconsistent_access');
  }

  const currentPermissions = new Set(input.currentPermissions);
  const currentFields = new Set(input.currentFieldIds);
  const manageablePermissions = new Set(input.actorPermissions);
  const manageableFields =
    input.actorFieldScope.kind === 'all' ? null : new Set(input.actorFieldScope.fieldIds);
  const requestedWithFieldPermission =
    input.mode !== 'revoke_managed' && input.requestedFieldIds.length > 0
      ? [...input.requestedPermissions, 'change_allowed_fields' as const]
      : input.requestedPermissions;
  const requestedClosure = closePermissionDependencies(requestedWithFieldPermission);

  if (!input.actorIsAdministrator && input.mode === 'full_revoke') {
    if ([...currentPermissions].some((permission) => !manageablePermissions.has(permission))) {
      throw new AccessPolicyError('permission_outside_actor_scope');
    }
    if (
      manageableFields !== null &&
      [...currentFields].some((fieldId) => !manageableFields.has(fieldId))
    ) {
      throw new AccessPolicyError('field_outside_actor_scope');
    }
  }

  if (
    !input.actorIsAdministrator &&
    input.mode !== 'revoke_managed' &&
    requestedClosure.permissions.includes('manage_access')
  ) {
    throw new AccessPolicyError('manage_access_requires_administrator');
  }
  if (
    !input.actorIsAdministrator &&
    requestedClosure.permissions.some((permission) => !manageablePermissions.has(permission))
  ) {
    throw new AccessPolicyError('permission_outside_actor_scope');
  }
  if (
    manageableFields !== null &&
    input.requestedFieldIds.some((fieldId) => !manageableFields.has(fieldId))
  ) {
    throw new AccessPolicyError('field_outside_actor_scope');
  }

  let desiredPermissions: Set<Permission>;
  let desiredFields: Set<string>;
  switch (input.mode) {
    case 'full_revoke':
      desiredPermissions = new Set();
      desiredFields = new Set();
      break;
    case 'revoke_managed':
      desiredPermissions = new Set(
        [...currentPermissions].filter(
          (permission) =>
            permission === 'app_access' || !input.requestedPermissions.includes(permission),
        ),
      );
      desiredFields = new Set(
        [...currentFields].filter((fieldId) => !input.requestedFieldIds.includes(fieldId)),
      );
      break;
    case 'grant':
      desiredPermissions = new Set([...currentPermissions, ...requestedClosure.permissions]);
      desiredFields = new Set([...currentFields, ...input.requestedFieldIds]);
      break;
    case 'replace_managed':
      desiredPermissions = new Set([
        ...[...currentPermissions].filter(
          (permission) => !manageablePermissions.has(permission),
        ),
        ...requestedClosure.permissions,
      ]);
      desiredFields = new Set([
        ...[...currentFields].filter(
          (fieldId) => manageableFields !== null && !manageableFields.has(fieldId),
        ),
        ...input.requestedFieldIds,
      ]);
      break;
    case 'repair':
      desiredPermissions = new Set(requestedClosure.permissions);
      desiredFields = new Set(input.requestedFieldIds);
      break;
  }

  // Dependencies of authority outside a delegated manager's scope are protected too. Otherwise
  // removing a visible prerequisite could silently remove a hidden permission.
  if (!input.actorIsAdministrator) {
    const protectedPermissions = [...currentPermissions].filter(
      (permission) => !manageablePermissions.has(permission) && desiredPermissions.has(permission),
    );
    const protectedClosure = closePermissionDependencies(protectedPermissions).permissions;
    for (const permission of protectedClosure) desiredPermissions.add(permission);
  }

  // A permission needed by protected fields cannot be removed by a manager who cannot see those
  // fields. The base entitlement is revoked only by full_revoke or an administrator repair.
  if (desiredFields.size > 0 && currentPermissions.has('change_allowed_fields')) {
    desiredPermissions.add('change_allowed_fields');
  }
  if (desiredPermissions.size > 0 || desiredFields.size > 0) {
    desiredPermissions.add('app_access');
  }
  if (input.mode === 'revoke_managed' && desiredFields.size === 0) {
    desiredPermissions.delete('change_allowed_fields');
  }

  // Revoking a prerequisite also revokes every dependent permission. This is a reverse closure:
  // repeat until no remaining permission has a missing dependency.
  let removedInvalidDependency = true;
  while (removedInvalidDependency) {
    removedInvalidDependency = false;
    for (const permission of [...desiredPermissions]) {
      if (
        permissionDependencies[permission].some(
          (dependency) => !desiredPermissions.has(dependency),
        )
      ) {
        desiredPermissions.delete(permission);
        removedInvalidDependency = true;
      }
    }
  }
  if (
    currentPermissions.has('app_access') &&
    !desiredPermissions.has('app_access') &&
    input.mode !== 'full_revoke' &&
    input.mode !== 'repair'
  ) {
    throw new AccessPolicyError('app_access_requires_full_revoke');
  }

  if (desiredFields.size > 0 && !desiredPermissions.has('change_allowed_fields')) {
    throw new AccessPolicyError('allowed_fields_require_permission');
  }
  if (desiredPermissions.size > 0 && !desiredPermissions.has('app_access')) {
    throw new AccessPolicyError('allowed_fields_require_permission');
  }

  const addedPermissions = ordered(
    [...desiredPermissions].filter((permission) => !currentPermissions.has(permission)),
  );
  const removedPermissions = ordered(
    [...currentPermissions].filter((permission) => !desiredPermissions.has(permission)),
  );
  const addedFieldIds = orderedFields(
    [...desiredFields].filter((fieldId) => !currentFields.has(fieldId)),
  );
  const removedFieldIds = orderedFields(
    [...currentFields].filter((fieldId) => !desiredFields.has(fieldId)),
  );
  const explicitlyRemovedPermissions = new Set<Permission>();
  switch (input.mode) {
    case 'revoke_managed':
      for (const permission of input.requestedPermissions) {
        explicitlyRemovedPermissions.add(permission);
      }
      break;
    case 'replace_managed':
      for (const permission of currentPermissions) {
        if (manageablePermissions.has(permission) && !requestedClosure.permissions.includes(permission)) {
          explicitlyRemovedPermissions.add(permission);
        }
      }
      break;
    case 'full_revoke':
    case 'repair':
      for (const permission of currentPermissions) explicitlyRemovedPermissions.add(permission);
      break;
    case 'grant':
      break;
  }
  const automaticRemovedPermissions = removedPermissions.filter(
    (permission) => !explicitlyRemovedPermissions.has(permission),
  );
  if ((removedPermissions.length > 0 || removedFieldIds.length > 0) && !input.hasReductionReason) {
    throw new AccessPolicyError('reason_required');
  }

  const hasAllReports = desiredPermissions.has('view_all_reports');
  const requiresSensitiveConfirmation = addedPermissions.some(
    (permission) =>
      sensitivePermissions.has(permission) ||
      (hasAllReports &&
        ['export_reports', 'retry_operations', 'restore_operations'].includes(permission)),
  );

  return {
    desiredPermissions: ordered(desiredPermissions),
    desiredFieldIds: orderedFields(desiredFields),
    requestedPermissions: ordered(input.requestedPermissions),
    automaticPermissions: requestedClosure.automaticPermissions,
    automaticAddedPermissions: requestedClosure.automaticPermissions.filter((permission) =>
      addedPermissions.includes(permission),
    ),
    automaticRemovedPermissions,
    addedPermissions,
    removedPermissions,
    addedFieldIds,
    removedFieldIds,
    requiresSensitiveConfirmation,
    noChange:
      input.mode !== 'repair' &&
      addedPermissions.length === 0 &&
      removedPermissions.length === 0 &&
      addedFieldIds.length === 0 &&
      removedFieldIds.length === 0,
  };
}
