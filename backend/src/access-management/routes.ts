import {
  accessManagementCommandReceiptSchema,
  accessManagementCommandRequestSchema,
  accessManagementConfirmationRequestSchema,
  accessManagementConfirmationSchema,
  accessManagementDiffSchema,
  accessManagementDraftIntentSchema,
  accessManagementDraftSaveResponseSchema,
  accessManagementPreflightSchema,
  accessEmployeeProfileSchema,
  accessEmployeeSummarySchema,
  accessEmployeeSearchResponseSchema,
  accessFieldSetMembersResponseSchema,
  accessPermissionCatalog,
  appPermissions,
  type AccessEmployeeSummary,
  type AccessChangeMode,
  type AccessFieldScopeReference,
  type AccessManagementCommandReceipt,
  type AccessManagementDiff,
  type AccessManagementPreflight,
  type Permission,
} from '@task-commander/contracts';
import { Hono } from 'hono';
import { z } from 'zod';

import {
  createAccessConfirmationToken,
  InvalidSignedTokenError,
  verifyAccessConfirmationToken,
} from '../auth/signed-token';
import type { VerifiedSessionPrincipal } from '../auth/session-service';
import type { AccessManagementRepository } from '../data/access-management-repository';
import type { DatabaseTable, Json } from '../data/database.types';
import type { EffectiveAccess } from '../data/access';
import { EffectiveAccessError } from '../data/access';
import { DataAccessError } from '../data/errors';
import { ApiHttpError } from '../http/errors';
import { parseJsonBody } from '../http/validation';
import type {
  BitrixAdapter,
  BitrixEmployeeProfile,
  BitrixFailure,
} from '../integrations/bitrix/contract';
import type { RuntimeEnvironment } from '../runtime/configuration';
import { authorizeAccessManager, type AccessManagerAuthorization } from './authorization';
import { dispatchAccessCommand } from './dispatch';
import { AccessPolicyError, evaluateAccessChange } from './policy';

export interface AccessManagementRouteVariables {
  correlationId: string;
}

export interface AccessManagementRouteDependencies {
  readPrincipal(env: RuntimeEnvironment, cookie: string | null): Promise<VerifiedSessionPrincipal>;
  readEffectiveAccess(
    env: RuntimeEnvironment,
    principal: VerifiedSessionPrincipal,
  ): Promise<EffectiveAccess>;
  createAdapter(env: RuntimeEnvironment, input: { currentUserId: string }): BitrixAdapter;
  createRepository(env: RuntimeEnvironment): AccessManagementRepository;
}

const userSearchQuerySchema = z
  .object({
    q: z.string().trim().max(256).default(''),
    cursor: z.string().trim().min(1).max(128).nullable().default(null),
    pageSize: z.coerce.number().int().min(1).max(50).default(50),
    departmentId: z.string().regex(/^\d+$/).min(1).max(32).nullable().default(null),
    includeInactive: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
    status: z.enum(['all', 'active', 'none']).default('all'),
  })
  .strict();

const fieldsQuerySchema = z
  .object({
    q: z.string().trim().max(256).default(''),
    cursor: z.coerce.number().int().nonnegative().default(0),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

const fieldMembersQuerySchema = z
  .object({
    version: z.coerce.number().int().positive(),
    cursor: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    targetUserId: z.string().regex(/^\d+$/).min(1).max(32).optional(),
  })
  .strict();

const idSchema = z.string().uuid();

function toApiError(failure: BitrixFailure): ApiHttpError {
  switch (failure.kind) {
    case 'not_authenticated':
      return new ApiHttpError(401, 'UNAUTHENTICATED');
    case 'permission_denied':
      return new ApiHttpError(403, 'FORBIDDEN');
    case 'not_found_or_forbidden':
      return new ApiHttpError(404, 'NOT_FOUND');
    case 'rate_limited':
      return new ApiHttpError(429, 'RATE_LIMITED');
    default:
      return new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
  }
}

function toAuthorizationApiError(error: EffectiveAccessError): ApiHttpError {
  switch (error.kind) {
    case 'forbidden':
      return new ApiHttpError(403, 'FORBIDDEN');
    case 'not_found':
      return new ApiHttpError(404, 'NOT_FOUND');
    case 'upstream_unavailable':
      return new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
  }
}

function mapDataError(error: unknown): never {
  if (error instanceof DataAccessError) {
    if (error.code === 'RATE_LIMITED') throw new ApiHttpError(429, 'RATE_LIMITED');
    if (error.code === 'CONFLICT') throw new ApiHttpError(409, 'CONFLICT');
    if (error.code === 'CONFIGURATION' || error.code === 'UNAVAILABLE') {
      throw new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
    }
  }
  throw error;
}

function departmentPath(
  departmentId: string,
  byId: ReadonlyMap<string, { id: string; name: string; parentId: string | null }>,
): string[] {
  const names: string[] = [];
  const visited = new Set<string>();
  let current = byId.get(departmentId);
  while (current && !visited.has(current.id) && names.length < 32) {
    visited.add(current.id);
    names.unshift(current.name);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return names;
}

const taskFieldLabels: Readonly<Record<string, string>> = Object.freeze({
  title: 'Название',
  description: 'Описание',
  creator_id: 'Постановщик',
  responsible_id: 'Ответственный',
  accomplice_ids: 'Соисполнители',
  auditor_ids: 'Наблюдатели',
  deadline: 'Крайний срок',
  start_date: 'Дата начала',
  priority: 'Приоритет',
  status: 'Статус',
  group_id: 'Проект или группа',
  tags: 'Теги',
});

function taskFieldLabel(fieldId: string): string {
  return taskFieldLabels[fieldId] ?? fieldId;
}

function asJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

function sameStringSet(value: unknown, expected: readonly string[]): boolean {
  const parsed = z.array(z.string()).safeParse(value);
  return parsed.success &&
    JSON.stringify([...parsed.data].sort()) === JSON.stringify([...expected].sort());
}

function stableRecord(value: unknown): string {
  const parsed = z.record(z.unknown()).safeParse(value);
  return parsed.success
    ? JSON.stringify(Object.fromEntries(Object.entries(parsed.data).sort(([left], [right]) =>
        left.localeCompare(right),
      )))
    : '';
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fieldReference(row: DatabaseTable<'access_field_set'>): AccessFieldScopeReference {
  return {
    kind: 'set',
    fieldSetId: row.id,
    version: row.version,
    count: row.member_count,
    fingerprint: row.fingerprint,
  };
}

function accessState(row: DatabaseTable<'user_settings'> | undefined) {
  if (!row) return 'revoked' as const;
  return ['active', 'revoked', 'quarantined', 'review_required'].includes(row.access_state)
    ? (row.access_state as 'active' | 'revoked' | 'quarantined' | 'review_required')
    : ('quarantined' as const);
}

function permissionList(row: DatabaseTable<'user_settings'> | undefined): Permission[] {
  return (row?.permissions ?? []).filter((value): value is Permission =>
    appPermissions.includes(value as Permission),
  );
}

function makeDelta(
  beforePermissions: readonly Permission[],
  afterPermissions: readonly Permission[],
  beforeFields: readonly string[],
  afterFields: readonly string[],
  beforeRef: AccessFieldScopeReference,
  afterRef: AccessFieldScopeReference,
): AccessManagementDiff {
  const beforePermissionSet = new Set(beforePermissions);
  const afterPermissionSet = new Set(afterPermissions);
  const beforeFieldSet = new Set(beforeFields);
  const afterFieldSet = new Set(afterFields);
  return {
    permissions: {
      added: afterPermissions.filter((permission) => !beforePermissionSet.has(permission)),
      removed: beforePermissions.filter((permission) => !afterPermissionSet.has(permission)),
    },
    fields: {
      before: beforeRef,
      after: afterRef,
      addedCount: afterFields.filter((fieldId) => !beforeFieldSet.has(fieldId)).length,
      removedCount: beforeFields.filter((fieldId) => !afterFieldSet.has(fieldId)).length,
    },
  };
}

function issueFor(error: AccessPolicyError) {
  const codes: Partial<Record<AccessPolicyError['code'], string>> = {
    manager_cannot_manage_self: 'ACTOR_ACCESS_CHANGED',
    administrator_target_is_read_only: 'ADMIN_ACCESS_IMMUTABLE',
    inactive_target: 'EMPLOYEE_INACTIVE',
    manage_access_requires_administrator: 'BITRIX_ADMIN_REQUIRED',
    permission_outside_actor_scope: 'PERMISSION_NOT_DELEGABLE',
    field_outside_actor_scope: 'FIELD_SCOPE_NOT_DELEGABLE',
    allowed_fields_require_permission: 'PERMISSION_DEPENDENCY_MISSING',
    repair_requires_administrator: 'BITRIX_ADMIN_REQUIRED',
    repair_requires_inconsistent_access: 'ACCESS_REVIEW_REQUIRED',
    reason_required: 'REDUCTION_REASON_REQUIRED',
  };
  return {
    code: (codes[error.code] ?? 'PERMISSION_NOT_DELEGABLE') as
      | 'ACTOR_ACCESS_CHANGED'
      | 'ADMIN_ACCESS_IMMUTABLE'
      | 'EMPLOYEE_INACTIVE'
      | 'BITRIX_ADMIN_REQUIRED'
      | 'PERMISSION_NOT_DELEGABLE'
      | 'FIELD_SCOPE_NOT_DELEGABLE'
      | 'PERMISSION_DEPENDENCY_MISSING'
      | 'ACCESS_REVIEW_REQUIRED'
      | 'REDUCTION_REASON_REQUIRED',
    message:
      error.code === 'reason_required'
        ? 'Для сокращения доступа необходимо указать причину.'
        : 'Изменение не прошло проверку полномочий и текущего состояния.',
  };
}

function mapCommandReceipt(
  command: DatabaseTable<'access_command'>,
  targets: DatabaseTable<'access_command_target'>[],
  mode: AccessManagementCommandReceipt['mode'],
): AccessManagementCommandReceipt {
  return accessManagementCommandReceiptSchema.parse({
    commandId: command.id,
    preflightId: command.preflight_id,
    state: command.state,
    mode,
    acceptedAt: command.accepted_at,
    startedAt: command.started_at,
    completedAt: command.completed_at,
    summary: {
      total: command.total_count,
      ready: command.ready_count,
      excluded: command.excluded_count,
      conflicts: command.conflict_count,
      applied: command.applied_count,
      failed: command.failed_count,
      noChange: command.no_change_count,
    },
    targets: targets.map((target) => {
      const plannedDelta = accessManagementDiffSchema.parse(target.redacted_delta);
      const appliedDelta = target.state === 'applied'
        ? plannedDelta
        : {
            permissions: { added: [], removed: [] },
            fields: {
              before: plannedDelta.fields.before,
              after: plannedDelta.fields.before,
              addedCount: 0,
              removedCount: 0,
            },
          };
      return {
        userId: target.target_user_id,
        displayName: target.target_display_name,
        state: target.state,
        beforeAccessVersion: target.before_access_version,
        afterAccessVersion: target.after_access_version,
        appliedDelta,
        reasonCode: target.reason_code,
        notificationState: target.notification_state,
      };
    }),
  });
}

export function createAccessManagementRoutes(dependencies: AccessManagementRouteDependencies) {
  const routes = new Hono<{
    Bindings: RuntimeEnvironment;
    Variables: AccessManagementRouteVariables;
  }>();

  routes.use('*', async (context, next) => {
    context.header('cache-control', 'no-store');
    context.header('vary', 'Cookie');
    await next();
  });

  async function authorize(context: {
    env: RuntimeEnvironment;
    req: { header(name: string): string | undefined };
  }): Promise<AccessManagerAuthorization> {
    const principal = await dependencies.readPrincipal(context.env, context.req.header('cookie') ?? null);
    const access = await dependencies.readEffectiveAccess(context.env, principal);
    const adapter = dependencies.createAdapter(context.env, { currentUserId: principal.userId });
    try {
      return await authorizeAccessManager({ principal, access, adapter });
    } catch (error) {
      if (error instanceof EffectiveAccessError) throw toAuthorizationApiError(error);
      throw error;
    }
  }

  async function actorVersion(
    authorization: AccessManagerAuthorization,
    repository: AccessManagementRepository,
  ): Promise<number> {
    if (authorization.isAdministrator) return 1;
    const [settings] = await repository.findSettings({
      portalId: authorization.principal.portalId,
      userIds: [authorization.principal.userId],
    });
    if (!settings || settings.access_state !== 'active') throw new ApiHttpError(403, 'FORBIDDEN');
    return settings.access_version;
  }

  routes.get('/capabilities', async (context) => {
    const authorization = await authorize(context);
    const repository = dependencies.createRepository(context.env);
    return context.json({
      actor: {
        id: authorization.principal.userId,
        displayName: authorization.principal.displayName,
        isAdministrator: authorization.isAdministrator,
      },
      canManageAccess: true,
      canGrantManageAccess: authorization.isAdministrator,
      manageablePermissions: authorization.manageablePermissions,
      permissionCatalogVersion: accessPermissionCatalog.version,
      actorAccessVersion: await actorVersion(authorization, repository),
      bitrixCheckedAt: new Date().toISOString(),
      limits: { recipients: 100, draftHours: 24, preflightMinutes: 10 },
    });
  });

  routes.get('/users', async (context) => {
    const authorization = await authorize(context);
    const parsed = userSearchQuerySchema.safeParse({
      q: context.req.query('q') ?? '',
      cursor: context.req.query('cursor') ?? null,
      pageSize: context.req.query('pageSize') ?? '50',
      departmentId: context.req.query('departmentId') ?? null,
      includeInactive: context.req.query('includeInactive') ?? 'true',
      status: context.req.query('status') ?? 'all',
    });
    if (!parsed.success) throw new ApiHttpError(400, 'INVALID_REQUEST');
    const repository = dependencies.createRepository(context.env);
    let sourceEmployees: BitrixEmployeeProfile[] = [];
    let upstreamNextCursor: string | null = null;
    if (parsed.data.status !== 'all') {
      try {
        await repository.consumeFilteredSearchLimit(
          authorization.principal.portalId,
          authorization.principal.userId,
        );
      } catch (error) {
        mapDataError(error);
      }
    }
    // Access state is local, so a filtered cursor advances one bounded Bitrix page at a time.
    // Empty filtered pages intentionally retain nextCursor: this avoids an unbounded upstream
    // fan-out while guaranteeing that no employee is skipped or duplicated.
    const sourceResult = await authorization.adapter.users.searchEmployees({
      query: parsed.data.q,
      cursor: parsed.data.cursor,
      pageSize: parsed.data.pageSize,
      departmentId: parsed.data.departmentId,
      includeInactive: parsed.data.includeInactive,
    });
    if (!sourceResult.ok) throw toApiError(sourceResult.failure);
    sourceEmployees = [...sourceResult.value.items];
    upstreamNextCursor = sourceResult.value.nextCursor;
    const settings: DatabaseTable<'user_settings'>[] = [];
    for (let offset = 0; offset < sourceEmployees.length; offset += 100) {
      settings.push(
        ...(await repository.findSettings({
          portalId: authorization.principal.portalId,
          userIds: sourceEmployees
            .slice(offset, offset + 100)
            .map((employee) => employee.id),
        })),
      );
    }
    const departmentsResult = await authorization.adapter.organization.getDepartments();
    if (!departmentsResult.ok) throw toApiError(departmentsResult.failure);
    const byId = new Map(departmentsResult.value.map((department) => [department.id, department]));
    const settingsById = new Map(settings.map((row) => [row.user_id, row]));
    const emptySetId = await repository.resolveFieldSet(authorization.principal.portalId, []);
    const fieldSets = await repository.findFieldSets({
      portalId: authorization.principal.portalId,
      fieldSetIds: [
        emptySetId,
        ...settings.flatMap((row) => (row.field_set_id ? [row.field_set_id] : [])),
      ],
    });
    const fieldSetById = new Map(fieldSets.map((row) => [row.id, row]));
    const emptySet = fieldSetById.get(emptySetId);
    if (!emptySet) throw new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
    const managerIds = new Set(
      departmentsResult.value.flatMap((department) =>
        department.headUserId === null ? [] : [department.headUserId],
      ),
    );
    const filteredItems = sourceEmployees
      .map((employee) => {
        const row = settingsById.get(employee.id);
        const storedAccessState = employee.isAdmin ? 'active' : accessState(row);
        const effectiveAccessState =
          !employee.isActive && storedAccessState === 'active'
            ? 'review_required'
            : storedAccessState;
        const fieldSet = row?.field_set_id ? fieldSetById.get(row.field_set_id) : emptySet;
        if (!fieldSet) throw new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
        return accessEmployeeSummarySchema.parse({
          userId: employee.id,
          displayName: employee.displayName,
          jobTitle: employee.position,
          departmentName: employee.departmentIds[0]
            ? byId.get(employee.departmentIds[0])?.name ?? null
            : null,
          avatarUrl: employee.photoUrl,
          employmentState: employee.isActive ? 'active' : 'inactive',
          accessState: effectiveAccessState,
          accessVersion: row?.access_version ?? null,
          permissionCount: employee.isAdmin ? appPermissions.length : permissionList(row).length,
          fieldScope: employee.isAdmin ? { kind: 'all' } : fieldReference(fieldSet),
          isManager: managerIds.has(employee.id),
          isBitrixAdmin: employee.isAdmin,
          isSelf: employee.id === authorization.principal.userId,
          canManage:
            employee.id !== authorization.principal.userId &&
            !employee.isAdmin &&
            employee.isActive &&
            (effectiveAccessState !== 'quarantined' && effectiveAccessState !== 'review_required' ||
              authorization.isAdministrator),
        });
      })
      .filter((employee) =>
        parsed.data.status === 'all'
          ? true
          : parsed.data.status === 'active'
            ? employee.accessState === 'active'
            : employee.accessState === 'revoked',
      );
    return context.json(
      accessEmployeeSearchResponseSchema.parse({
        checkedAt: new Date().toISOString(),
        employees: filteredItems,
        nextCursor: upstreamNextCursor,
      }),
    );
  });

  routes.get('/users/:userId', async (context) => {
    const authorization = await authorize(context);
    const result = await authorization.adapter.users.getEmployeeProfile(context.req.param('userId'));
    if (!result.ok) throw toApiError(result.failure);
    const employee = result.value;
    const repository = dependencies.createRepository(context.env);
    const [row] = await repository.findSettings({
      portalId: authorization.principal.portalId,
      userIds: [employee.id],
    });
    const [leadership, departmentsResult] = await Promise.all([
      authorization.adapter.organization.getLeadership(employee.id),
      authorization.adapter.organization.getDepartments(),
    ]);
    if (!leadership.ok) throw toApiError(leadership.failure);
    if (!departmentsResult.ok) throw toApiError(departmentsResult.failure);
    const byId = new Map(departmentsResult.value.map((department) => [department.id, department]));
    const storedAccessState = employee.isAdmin ? 'active' : accessState(row);
    const effectiveAccessState =
      !employee.isActive && storedAccessState === 'active' ? 'review_required' : storedAccessState;
    const emptySetId = await repository.resolveFieldSet(authorization.principal.portalId, []);
    const [fieldSet] = await repository.findFieldSets({
      portalId: authorization.principal.portalId,
      fieldSetIds: [row?.field_set_id ?? emptySetId],
    });
    if (!fieldSet && !employee.isAdmin) throw new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
    const targetIsManager = leadership.value.length > 0;
    const isSelf = employee.id === authorization.principal.userId;
    const blockingReasonCode = employee.isAdmin
      ? 'ADMIN_ACCESS_IMMUTABLE'
      : isSelf
        ? 'ACTOR_ACCESS_CHANGED'
        : !employee.isActive
          ? 'EMPLOYEE_INACTIVE'
          : effectiveAccessState === 'quarantined'
            ? 'ACCESS_QUARANTINED'
            : effectiveAccessState === 'review_required'
              ? 'ACCESS_REVIEW_REQUIRED'
              : null;
    const targetPermissions = employee.isAdmin ? appPermissions : permissionList(row);
    const visibleTargetPermissions = authorization.isAdministrator
      ? targetPermissions
      : targetPermissions.filter((permission) =>
          authorization.manageablePermissions.includes(permission),
        );
    const targetFields = row?.allowed_field_ids ?? [];
    const actorFields = authorization.access.fieldScope.kind === 'all'
      ? null
      : new Set(authorization.access.fieldScope.fieldIds);
    const canFullRevoke = authorization.isAdministrator ||
      (targetPermissions.every((permission) =>
        authorization.manageablePermissions.includes(permission),
      ) &&
        (actorFields === null || targetFields.every((fieldId) => actorFields.has(fieldId))));
    const availableModes: AccessChangeMode[] = blockingReasonCode === null
      ? [
          'grant',
          'replace_managed',
          'revoke_managed',
          ...(canFullRevoke ? ['full_revoke' as const] : []),
        ]
      : authorization.isAdministrator &&
          !isSelf &&
          employee.isActive &&
          (effectiveAccessState === 'quarantined' || effectiveAccessState === 'review_required')
        ? ['repair']
        : [];
    let delegableFieldScope: AccessFieldScopeReference;
    if (authorization.access.fieldScope.kind === 'all') {
      delegableFieldScope = { kind: 'all' };
    } else {
      const actorSetId = await repository.resolveFieldSet(
        authorization.principal.portalId,
        authorization.access.fieldScope.fieldIds,
      );
      const [actorSet] = await repository.findFieldSets({
        portalId: authorization.principal.portalId,
        fieldSetIds: [actorSetId],
      });
      if (!actorSet) throw new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
      delegableFieldScope = fieldReference(actorSet);
    }
    return context.json(accessEmployeeProfileSchema.parse({
      employee: {
        userId: employee.id,
        displayName: employee.displayName,
        jobTitle: employee.position,
        departmentName: employee.departmentIds[0]
          ? byId.get(employee.departmentIds[0])?.name ?? null
          : null,
        avatarUrl: employee.photoUrl,
        employmentState: employee.isActive ? 'active' : 'inactive',
        accessState: effectiveAccessState,
        accessVersion: row?.access_version ?? null,
        permissionCount: employee.isAdmin ? appPermissions.length : permissionList(row).length,
        fieldScope: employee.isAdmin ? { kind: 'all' } : fieldReference(fieldSet!),
        isManager: targetIsManager,
        isBitrixAdmin: employee.isAdmin,
        isSelf,
        canManage: availableModes.length > 0,
      },
      access: {
        settingsVersion: row?.access_version ?? null,
        permissionCatalogVersion: row?.permission_matrix_version ?? accessPermissionCatalog.version,
        permissions: visibleTargetPermissions,
        fieldScope: employee.isAdmin ? { kind: 'all' } : fieldReference(fieldSet!),
        grantedAt: row?.granted_at ?? null,
        updatedAt: row?.updated_at ?? null,
        grantedByUserId: row?.granted_by_user_id ?? null,
      },
      capabilities: {
        canManage: availableModes.length > 0,
        availableModes,
        delegablePermissions: authorization.manageablePermissions,
        delegableFieldScope,
        blockingReasonCode,
      },
      checkedAt: new Date().toISOString(),
    }));
  });

  routes.get('/departments', async (context) => {
    const authorization = await authorize(context);
    const result = await authorization.adapter.organization.getDepartments();
    if (!result.ok) throw toApiError(result.failure);
    const byId = new Map(result.value.map((department) => [department.id, department]));
    return context.json({
      items: result.value.map((department) => ({ ...department, path: departmentPath(department.id, byId) })),
    });
  });

  routes.post('/department-snapshots/:departmentId', async (context) => {
    const authorization = await authorize(context);
    const result = await authorization.adapter.organization.snapshotDepartmentMembers(
      context.req.param('departmentId'),
    );
    if (!result.ok) throw toApiError(result.failure);
    const profiles = await authorization.adapter.users.getByIds(result.value.memberIds);
    if (!profiles.ok) throw toApiError(profiles.failure);
    const editableMemberIds = profiles.value
      .filter((employee) =>
        employee.isActive &&
        !employee.isAdmin &&
        employee.id !== authorization.principal.userId,
      )
      .map((employee) => employee.id);
    return context.json({
      ...result.value,
      memberIds: editableMemberIds,
      excludedCount: result.value.memberIds.length - editableMemberIds.length,
    }, 201);
  });

  routes.get('/fields', async (context) => {
    const authorization = await authorize(context);
    const parsed = fieldsQuerySchema.safeParse({
      q: context.req.query('q') ?? '',
      cursor: context.req.query('cursor') ?? '0',
      pageSize: context.req.query('pageSize') ?? '50',
    });
    if (!parsed.success) throw new ApiHttpError(400, 'INVALID_REQUEST');
    const result = await authorization.adapter.tasks.getFieldCapabilities();
    if (!result.ok) throw toApiError(result.failure);
    const query = parsed.data.q.toLocaleLowerCase('ru');
    const manageable = new Set(
      authorization.access.fieldScope.kind === 'all'
        ? result.value.map((field) => field.id)
        : authorization.access.fieldScope.fieldIds,
    );
    const filtered = result.value.filter(
      (field) =>
        field.isSupported && field.isEditable &&
        (query === '' ||
          field.id.toLocaleLowerCase('ru').includes(query) ||
          taskFieldLabel(field.id).toLocaleLowerCase('ru').includes(query)),
    );
    const items = filtered.slice(parsed.data.cursor, parsed.data.cursor + parsed.data.pageSize);
    const nextOffset = parsed.data.cursor + items.length;
    return context.json({
      items: items.map((field) => ({
        ...field,
        label: taskFieldLabel(field.id),
        group: field.id.startsWith('uf_') ? 'Пользовательские поля' : 'Основные поля',
        manageable: manageable.has(field.id),
      })),
      nextCursor: nextOffset < filtered.length ? String(nextOffset) : null,
      total: filtered.length,
      catalogVersion: 1,
    });
  });

  routes.get('/field-sets/:fieldSetId/members', async (context) => {
    const authorization = await authorize(context);
    const fieldSetId = idSchema.safeParse(context.req.param('fieldSetId'));
    const query = fieldMembersQuerySchema.safeParse(context.req.query());
    if (!fieldSetId.success || !query.success) throw new ApiHttpError(400, 'INVALID_REQUEST');
    const repository = dependencies.createRepository(context.env);
    const [set] = await repository.findFieldSets({
      portalId: authorization.principal.portalId,
      fieldSetIds: [fieldSetId.data],
    });
    if (!set || set.version !== query.data.version) throw new ApiHttpError(404, 'NOT_FOUND');
    if (!authorization.isAdministrator) {
      if (!query.data.targetUserId) throw new ApiHttpError(404, 'NOT_FOUND');
      const [targetSettings] = await repository.findSettings({
        portalId: authorization.principal.portalId,
        userIds: [query.data.targetUserId],
      });
      if (!targetSettings || targetSettings.field_set_id !== set.id) {
        throw new ApiHttpError(404, 'NOT_FOUND');
      }
    }
    const members = await repository.getFieldSetPage({
      portalId: authorization.principal.portalId,
      fieldSetId: set.id,
      afterOrdinal: query.data.cursor,
      limit: query.data.limit + 1,
    });
    const page = members.slice(0, query.data.limit);
    const manageableFields = authorization.access.fieldScope.kind === 'all'
      ? null
      : new Set(authorization.access.fieldScope.fieldIds);
    return context.json(accessFieldSetMembersResponseSchema.parse({
      reference: fieldReference(set),
      fieldIds: page
        .map((member) => member.field_id)
        .filter((fieldId) => manageableFields === null || manageableFields.has(fieldId)),
      nextCursor: members.length > query.data.limit
        ? String(page.at(-1)?.ordinal ?? query.data.cursor)
        : null,
    }));
  });

  routes.get('/draft', async (context) => {
    const authorization = await authorize(context);
    const draft = await dependencies.createRepository(context.env).readDraft({
      portalId: authorization.principal.portalId,
      managerUserId: authorization.principal.userId,
    });
    if (
      !draft ||
      !['editing', 'preflighted'].includes(draft.status) ||
      new Date(draft.expires_at) <= new Date()
    ) {
      return context.json({ revision: 0, status: 'empty' as const });
    }
    return context.json({ revision: draft.revision, status: draft.status });
  });

  routes.put('/draft', async (context) => {
    const authorization = await authorize(context);
    const intent = await parseJsonBody(context.req.raw, accessManagementDraftIntentSchema, 1_500_000);
    const repository = dependencies.createRepository(context.env);
    if ((await actorVersion(authorization, repository)) !== intent.actorAccessVersion) {
      throw new ApiHttpError(409, 'CONFLICT');
    }
    const actorFieldIds = authorization.access.fieldScope.kind === 'all'
      ? null
      : new Set(authorization.access.fieldScope.fieldIds);
    if (intent.fieldIds.some((fieldId) => actorFieldIds !== null && !actorFieldIds.has(fieldId))) {
      throw new ApiHttpError(403, 'FORBIDDEN');
    }
    if (
      !authorization.isAdministrator &&
      intent.mode !== 'revoke_managed' &&
      intent.permissions.includes('manage_access')
    ) {
      throw new ApiHttpError(403, 'FORBIDDEN');
    }
    if (intent.mode === 'revoke_managed') {
      const rows = await repository.findSettings({
        portalId: authorization.principal.portalId,
        userIds: intent.subjectIds,
      });
      const removable = new Set(rows.flatMap((row) => row.allowed_field_ids));
      if (intent.fieldIds.some((fieldId) => !removable.has(fieldId))) {
        throw new ApiHttpError(400, 'INVALID_REQUEST');
      }
    } else {
      const capabilities = await authorization.adapter.tasks.getFieldCapabilities();
      if (!capabilities.ok) throw toApiError(capabilities.failure);
      const assignable = new Set(
        capabilities.value
          .filter((field) => field.isSupported && field.isEditable)
          .map((field) => field.id),
      );
      if (intent.fieldIds.some((fieldId) => !assignable.has(fieldId))) {
        throw new ApiHttpError(400, 'INVALID_REQUEST');
      }
    }
    const fieldSetId = await repository.resolveFieldSet(
      authorization.principal.portalId,
      intent.fieldIds,
    );
    const [fieldSet] = await repository.findFieldSets({
      portalId: authorization.principal.portalId,
      fieldSetIds: [fieldSetId],
    });
    if (!fieldSet) throw new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
    const payload = {
      ...intent,
      fieldIds: undefined,
      fieldScope: fieldReference(fieldSet),
    };
    try {
      const saved = await repository.saveDraft({
        portalId: authorization.principal.portalId,
        managerUserId: authorization.principal.userId,
        expectedRevision: intent.draftRevision,
        payload: asJson(payload),
      });
      return context.json(accessManagementDraftSaveResponseSchema.parse({
        draftId: saved.id,
        revision: saved.revision,
        expiresAt: saved.expires_at,
      }));
    } catch (error) {
      mapDataError(error);
    }
  });

  routes.post('/preflights', async (context) => {
    const authorization = await authorize(context);
    const intent = await parseJsonBody(context.req.raw, accessManagementDraftIntentSchema, 1_500_000);
    const repository = dependencies.createRepository(context.env);
    const currentActorVersion = await actorVersion(authorization, repository);
    if (
      currentActorVersion !== intent.actorAccessVersion ||
      intent.permissionCatalogVersion !== accessPermissionCatalog.version
    ) {
      throw new ApiHttpError(409, 'CONFLICT');
    }
    const draft = await repository.readDraft({
      portalId: authorization.principal.portalId,
      managerUserId: authorization.principal.userId,
    });
    if (
      !draft ||
      draft.status !== 'editing' ||
      draft.revision !== intent.draftRevision
    ) {
      throw new ApiHttpError(409, 'CONFLICT');
    }
    const stored = z.record(z.unknown()).parse(draft.draft_payload);
    const storedFieldScope = z
      .object({ fieldSetId: idSchema })
      .passthrough()
      .safeParse(stored.fieldScope);
    if (!storedFieldScope.success) throw new ApiHttpError(409, 'CONFLICT');
    const requestedFieldSetId = await repository.resolveFieldSet(
      authorization.principal.portalId,
      intent.fieldIds,
    );
    if (
      requestedFieldSetId !== storedFieldScope.data.fieldSetId ||
      stored.mode !== intent.mode ||
      !sameStringSet(stored.permissions, intent.permissions) ||
      !sameStringSet(stored.subjectIds, intent.subjectIds) ||
      stableRecord(stored.subjectVersions) !== stableRecord(intent.subjectVersions) ||
      JSON.stringify(stored.reason ?? null) !== JSON.stringify(intent.reason)
    ) {
      throw new ApiHttpError(409, 'CONFLICT');
    }

    const [employeesResult, departmentsResult, fieldsResult, settings, requestedSets] = await Promise.all([
      authorization.adapter.users.getByIds(intent.subjectIds),
      authorization.adapter.organization.getDepartments(),
      authorization.adapter.tasks.getFieldCapabilities(),
      repository.findSettings({ portalId: authorization.principal.portalId, userIds: intent.subjectIds }),
      repository.findFieldSets({
        portalId: authorization.principal.portalId,
        fieldSetIds: [requestedFieldSetId],
      }),
    ]);
    if (!employeesResult.ok) throw toApiError(employeesResult.failure);
    if (!departmentsResult.ok) throw toApiError(departmentsResult.failure);
    if (!fieldsResult.ok) throw toApiError(fieldsResult.failure);
    const supportedFieldIds = new Set(
      fieldsResult.value
        .filter((field) => field.isSupported && field.isEditable)
        .map((field) => field.id),
    );
    if (
      intent.mode !== 'revoke_managed' &&
      intent.fieldIds.some((fieldId) => !supportedFieldIds.has(fieldId))
    ) {
      throw new ApiHttpError(400, 'INVALID_REQUEST');
    }
    const requestedSet = requestedSets[0];
    if (!requestedSet) throw new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
    const emptySetId = await repository.resolveFieldSet(authorization.principal.portalId, []);
    const allSetIds = [emptySetId, ...settings.flatMap((row) => (row.field_set_id ? [row.field_set_id] : []))];
    const fieldSets = await repository.findFieldSets({
      portalId: authorization.principal.portalId,
      fieldSetIds: allSetIds,
    });
    const fieldSetById = new Map(fieldSets.map((row) => [row.id, row]));
    const emptySet = fieldSetById.get(emptySetId);
    if (!emptySet) throw new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
    const settingsById = new Map(settings.map((row) => [row.user_id, row]));
    const employeesById = new Map(employeesResult.value.map((employee) => [employee.id, employee]));
    const departmentsById = new Map(departmentsResult.value.map((department) => [department.id, department]));
    const targets: AccessManagementPreflight['targets'] = [];
    const storageTargets: Record<string, unknown>[] = [];
    let sensitive = false;

    for (const userId of intent.subjectIds) {
      const employee = employeesById.get(userId);
      let targetIsManager = false;
      const requiresManagerTarget =
        intent.permissions.includes('manage_access') &&
        ['grant', 'replace_managed', 'repair'].includes(intent.mode);
      if (employee && requiresManagerTarget) {
        const leadership = await authorization.adapter.organization.getLeadership(userId);
        if (!leadership.ok) throw toApiError(leadership.failure);
        targetIsManager = leadership.value.length > 0;
      }
      const row = settingsById.get(userId);
      const beforePermissions = permissionList(row);
      const beforeFields = row?.allowed_field_ids ?? [];
      const beforeSet = row?.field_set_id ? fieldSetById.get(row.field_set_id) : emptySet;
      if (!beforeSet) throw new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
      const beforeRef = fieldReference(beforeSet);
      const rowState = accessState(row);
      const employeeSummary: AccessEmployeeSummary = {
        userId,
        displayName: employee?.displayName ?? `Сотрудник ${userId}`,
        jobTitle: null,
        departmentName: employee?.departmentIds[0]
          ? departmentsById.get(employee.departmentIds[0])?.name ?? null
          : null,
        avatarUrl: null,
        employmentState: employee ? (employee.isActive ? 'active' : 'inactive') : 'unknown',
        accessState: employee?.isAdmin ? 'active' : rowState,
        accessVersion: row?.access_version ?? null,
        permissionCount: employee?.isAdmin ? appPermissions.length : beforePermissions.length,
        fieldScope: beforeRef,
        isManager: targetIsManager,
        isBitrixAdmin: employee?.isAdmin ?? false,
        isSelf: userId === authorization.principal.userId,
        canManage: userId !== authorization.principal.userId &&
          !(employee?.isAdmin ?? false) && (employee?.isActive ?? false),
      };
      let state: 'ready' | 'excluded' | 'conflict' | 'no_change' = 'ready';
      let issue: ReturnType<typeof issueFor> | null = null;
      let desiredPermissions = beforePermissions;
      let desiredFields = beforeFields;
      let result: ReturnType<typeof evaluateAccessChange> | null = null;
      const baseVersion = intent.subjectVersions[userId] ?? null;
      if (baseVersion !== (row?.access_version ?? null)) {
        state = 'conflict';
        issue = { code: 'TARGET_ACCESS_CHANGED', message: 'Настройки сотрудника изменились.' };
      } else if (!employee) {
        state = 'excluded';
        issue = { code: 'EMPLOYMENT_STATE_UNKNOWN', message: 'Статус сотрудника не подтверждён.' };
      } else if (
        (rowState === 'quarantined' || rowState === 'review_required') &&
        intent.mode !== 'repair'
      ) {
        state = 'excluded';
        issue = {
          code: rowState === 'quarantined' ? 'ACCESS_QUARANTINED' : 'ACCESS_REVIEW_REQUIRED',
          message: 'Настройки необходимо восстановить в административном режиме.',
        };
      } else if (requiresManagerTarget && !targetIsManager) {
        state = 'excluded';
        issue = {
          code: 'MANAGER_STATUS_REQUIRED',
          message: 'Право управления доступом можно выдать только действующему руководителю.',
        };
      } else {
        try {
          result = evaluateAccessChange({
            mode: intent.mode,
            actorId: authorization.principal.userId,
            actorIsAdministrator: authorization.isAdministrator,
            actorPermissions: authorization.manageablePermissions,
            actorFieldScope: authorization.access.fieldScope,
            targetId: userId,
            targetIsAdministrator: employee.isAdmin,
            targetIsActive: employee.isActive,
            currentPermissions: beforePermissions,
            currentFieldIds: beforeFields,
            currentAccessState: rowState,
            requestedPermissions: intent.permissions,
            requestedFieldIds: intent.fieldIds,
            hasReductionReason: intent.reason !== null,
          });
          desiredPermissions = result.desiredPermissions;
          desiredFields = result.desiredFieldIds;
          sensitive ||= result.requiresSensitiveConfirmation;
          if (result.noChange) state = 'no_change';
        } catch (error) {
          if (!(error instanceof AccessPolicyError)) throw error;
          state = 'excluded';
          issue = issueFor(error);
        }
      }
      const desiredSetId = await repository.resolveFieldSet(
        authorization.principal.portalId,
        desiredFields,
      );
      const [desiredSet] = await repository.findFieldSets({
        portalId: authorization.principal.portalId,
        fieldSetIds: [desiredSetId],
      });
      if (!desiredSet) throw new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
      const delta = makeDelta(
        beforePermissions,
        desiredPermissions,
        beforeFields,
        desiredFields,
        beforeRef,
        fieldReference(desiredSet),
      );
      const automaticAdded = new Set(result?.automaticAddedPermissions ?? []);
      const automaticRemoved = new Set(result?.automaticRemovedPermissions ?? []);
      const automaticDelta: AccessManagementDiff = {
        ...delta,
        permissions: {
          added: delta.permissions.added.filter((permission) => automaticAdded.has(permission)),
          removed: delta.permissions.removed.filter((permission) =>
            automaticRemoved.has(permission),
          ),
        },
        fields: {
          before: delta.fields.before,
          after: delta.fields.before,
          addedCount: 0,
          removedCount: 0,
        },
      };
      const requestedDelta: AccessManagementDiff = {
        ...delta,
        permissions: {
          added: delta.permissions.added.filter((permission) => !automaticAdded.has(permission)),
          removed: delta.permissions.removed.filter((permission) =>
            !automaticRemoved.has(permission),
          ),
        },
      };
      targets.push({
        employee: employeeSummary,
        state,
        baseAccessVersion: baseVersion,
        checkedAccessVersion: row?.access_version ?? null,
        requestedDelta,
        automaticDelta,
        issues: issue ? [issue] : [],
      });
      storageTargets.push({
        targetUserId: userId,
        targetDisplayName: employeeSummary.displayName,
        targetDepartmentName: employeeSummary.departmentName,
        targetIsPortalAdmin: employeeSummary.isBitrixAdmin,
        targetIsManager,
        expectedAccessVersion: row?.access_version ?? null,
        expectedAccessState: employeeSummary.accessState,
        expectedPermissionCount: employeeSummary.permissionCount,
        desiredAccessState: desiredPermissions.includes('app_access') ? 'active' : 'revoked',
        desiredPermissions,
        desiredFieldSetId: desiredSetId,
        state,
        reasonCode: issue?.code ?? null,
        issueMessage: issue?.message ?? null,
        requestedDelta,
        automaticDelta,
        redactedDelta: delta,
      });
    }

    const summary = {
      total: targets.length,
      ready: targets.filter((target) => target.state === 'ready').length,
      excluded: targets.filter((target) => target.state === 'excluded').length,
      conflicts: targets.filter((target) => target.state === 'conflict').length,
      applied: 0,
      failed: 0,
      noChange: targets.filter((target) => target.state === 'no_change').length,
    };
    const confirmationRequired =
      sensitive || intent.mode === 'full_revoke' || intent.mode === 'revoke_managed' || summary.ready > 1;
    const confirmation = {
      required: confirmationRequired,
      tokenRequired: confirmationRequired,
      acknowledgementText: `Подтверждаю изменение доступа для ${summary.ready} сотрудников.`,
      recipientCount: summary.ready,
      validForSeconds: 300 as const,
    };
    let created: Json;
    try {
      created = await repository.createPreflight({
        portalId: authorization.principal.portalId,
        draftId: draft.id,
        expectedDraftRevision: draft.revision,
        managerUserId: authorization.principal.userId,
        managerAccessVersion: currentActorVersion,
        permissionMatrixVersion: accessPermissionCatalog.version,
        mode: intent.mode,
        requestFingerprint: await sha256({ draftId: draft.id, revision: draft.revision, intent }),
        summary: asJson({ ...summary, confirmation, reason: intent.reason }),
        targets: asJson(storageTargets),
      });
    } catch (error) {
      mapDataError(error);
    }
    const createdRecord = z
      .object({ preflight: z.object({ id: idSchema, created_at: z.string(), expires_at: z.string() }).passthrough() })
      .passthrough()
      .parse(created);
    return context.json(
      accessManagementPreflightSchema.parse({
        preflightId: createdRecord.preflight.id,
        draftId: draft.id,
        draftRevision: draft.revision,
        mode: intent.mode,
        permissionCatalogVersion: accessPermissionCatalog.version,
        actorAccessVersion: currentActorVersion,
        checkedAt: createdRecord.preflight.created_at,
        expiresAt: createdRecord.preflight.expires_at,
        ttlSeconds: 600,
        summary,
        targets,
        confirmation,
      }),
      201,
    );
  });

  async function readPreflightResponse(
    authorization: AccessManagerAuthorization,
    repository: AccessManagementRepository,
    preflightId: string,
  ): Promise<AccessManagementPreflight> {
    const stored = await repository.readPreflight({
      portalId: authorization.principal.portalId,
      preflightId,
    });
    if (!stored.preflight || stored.preflight.manager_user_id !== authorization.principal.userId) {
      throw new ApiHttpError(404, 'NOT_FOUND');
    }
    const storedSummary = z
      .object({
        total: z.number(), ready: z.number(), excluded: z.number(), conflicts: z.number(),
        applied: z.number(), failed: z.number(), noChange: z.number(),
        confirmation: z.record(z.unknown()),
      })
      .parse(stored.preflight.summary);
    const employeeResult = await authorization.adapter.users.getByIds(
      stored.targets.map((target) => target.target_user_id),
    );
    const employeeById = new Map(
      employeeResult.ok ? employeeResult.value.map((employee) => [employee.id, employee]) : [],
    );
    return accessManagementPreflightSchema.parse({
      preflightId: stored.preflight.id,
      draftId: stored.preflight.draft_id,
      draftRevision: stored.preflight.draft_revision,
      mode: stored.preflight.mode,
      permissionCatalogVersion: stored.preflight.permission_matrix_version,
      actorAccessVersion: stored.preflight.manager_access_version,
      checkedAt: stored.preflight.created_at,
      expiresAt: stored.preflight.expires_at,
      ttlSeconds: 600,
      summary: {
        total: storedSummary.total,
        ready: storedSummary.ready,
        excluded: storedSummary.excluded,
        conflicts: storedSummary.conflicts,
        applied: storedSummary.applied,
        failed: storedSummary.failed,
        noChange: storedSummary.noChange,
      },
      targets: stored.targets.map((target) => {
        const delta = accessManagementDiffSchema.parse(target.redacted_delta);
        const requestedDelta = accessManagementDiffSchema.parse(target.requested_delta);
        const automaticDelta = accessManagementDiffSchema.parse(target.automatic_delta);
        const liveEmployee = employeeById.get(target.target_user_id);
        return {
          employee: {
          userId: target.target_user_id,
          displayName: target.target_display_name,
          jobTitle: null,
          departmentName: target.target_department_name,
          avatarUrl: null,
          employmentState: liveEmployee
            ? liveEmployee.isActive
              ? 'active'
              : 'inactive'
            : 'unknown',
          accessState: target.expected_access_state,
          accessVersion: target.expected_access_version,
          permissionCount: target.expected_permission_count,
          fieldScope: delta.fields.before,
          isManager: target.target_is_manager,
          isBitrixAdmin: target.target_is_portal_admin,
          isSelf: target.target_user_id === authorization.principal.userId,
          canManage: false,
        },
        state: target.state,
        baseAccessVersion: target.expected_access_version,
        checkedAccessVersion: target.expected_access_version,
        requestedDelta,
        automaticDelta,
        issues: target.reason_code
          ? [{ code: target.reason_code, message: target.issue_message ?? 'Получатель исключён при проверке.' }]
          : [],
        };
      }),
      confirmation: storedSummary.confirmation,
    });
  }

  routes.get('/preflights/:preflightId', async (context) => {
    const authorization = await authorize(context);
    const preflightId = idSchema.safeParse(context.req.param('preflightId'));
    if (!preflightId.success) throw new ApiHttpError(400, 'INVALID_REQUEST');
    return context.json(
      await readPreflightResponse(
        authorization,
        dependencies.createRepository(context.env),
        preflightId.data,
      ),
    );
  });

  routes.post('/preflights/:preflightId/confirm', async (context) => {
    const authorization = await authorize(context);
    const input = await parseJsonBody(
      context.req.raw,
      accessManagementConfirmationRequestSchema,
      4_096,
    );
    if (input.preflightId !== context.req.param('preflightId')) {
      throw new ApiHttpError(400, 'INVALID_REQUEST');
    }
    const preflight = await readPreflightResponse(
      authorization,
      dependencies.createRepository(context.env),
      input.preflightId,
    );
    if (preflight.draftRevision !== input.draftRevision || new Date(preflight.expiresAt) <= new Date()) {
      throw new ApiHttpError(409, 'CONFLICT');
    }
    const issued = await createAccessConfirmationToken(
      {
        portalId: authorization.principal.portalId,
        actorUserId: authorization.principal.userId,
        preflightId: input.preflightId,
        draftRevision: input.draftRevision,
      },
      context.env.SESSION_SIGNING_SECRET,
    );
    return context.json(
      accessManagementConfirmationSchema.parse({
        confirmationId: issued.claims.confirmationId,
        preflightId: input.preflightId,
        draftRevision: input.draftRevision,
        token: issued.token,
        issuedAt: new Date(issued.claims.iat * 1_000).toISOString(),
        expiresAt: new Date(issued.claims.exp * 1_000).toISOString(),
        ttlSeconds: 300,
      }),
      201,
    );
  });

  routes.post('/commands', async (context) => {
    const authorization = await authorize(context);
    const input = await parseJsonBody(context.req.raw, accessManagementCommandRequestSchema, 8_192);
    const repository = dependencies.createRepository(context.env);
    const existing = await repository.readCommand({
      portalId: authorization.principal.portalId,
      commandId: input.commandId,
    });
    if (existing.command) {
      if (
        existing.command.actor_user_id !== authorization.principal.userId ||
        existing.command.preflight_id !== input.preflightId ||
        existing.command.confirmation_id !== (input.confirmationId ?? null)
      ) {
        throw new ApiHttpError(409, 'CONFLICT');
      }
      const existingPreflight = await repository.readPreflight({
        portalId: authorization.principal.portalId,
        preflightId: existing.command.preflight_id,
      });
      if (!existingPreflight.preflight) throw new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
      if (existing.command.state === 'accepted') {
        try {
          await dispatchAccessCommand({
            repository,
            env: context.env,
            portalId: authorization.principal.portalId,
            commandId: input.commandId,
          });
        } catch {
          // The durable dispatch outbox and scheduled recovery retain delivery responsibility.
        }
      }
      return context.json(
        mapCommandReceipt(existing.command, existing.targets, existingPreflight.preflight.mode),
        existing.command.state === 'accepted' ? 202 : 200,
      );
    }
    const preflight = await readPreflightResponse(authorization, repository, input.preflightId);
    if (
      preflight.permissionCatalogVersion !== accessPermissionCatalog.version ||
      preflight.actorAccessVersion !== await actorVersion(authorization, repository)
    ) {
      throw new ApiHttpError(409, 'CONFLICT');
    }
    if (preflight.confirmation.required) {
      if (!input.confirmationToken) throw new ApiHttpError(409, 'CONFLICT');
      try {
        const claims = await verifyAccessConfirmationToken(
          input.confirmationToken,
          context.env.SESSION_SIGNING_SECRET,
        );
        if (
          claims.portalId !== authorization.principal.portalId ||
          claims.actorUserId !== authorization.principal.userId ||
          claims.preflightId !== input.preflightId ||
          claims.draftRevision !== preflight.draftRevision
          || claims.confirmationId !== input.confirmationId
        ) {
          throw new ApiHttpError(409, 'CONFLICT');
        }
      } catch (error) {
        if (error instanceof ApiHttpError) throw error;
        if (error instanceof InvalidSignedTokenError) throw new ApiHttpError(409, 'CONFLICT');
        throw error;
      }
    } else if (input.confirmationId || input.confirmationToken) {
      throw new ApiHttpError(400, 'INVALID_REQUEST');
    }
    try {
      await repository.acceptCommand({
        portalId: authorization.principal.portalId,
        commandId: input.commandId,
        idempotencyKey: input.commandId,
        preflightId: input.preflightId,
        actorUserId: authorization.principal.userId,
        actorDisplayName: authorization.principal.displayName,
        actorIsPortalAdmin: authorization.isAdministrator,
        confirmationId: input.confirmationId ?? null,
        correlationId: context.get('correlationId'),
      });
    } catch (error) {
      mapDataError(error);
    }
    const stored = await repository.readCommand({
      portalId: authorization.principal.portalId,
      commandId: input.commandId,
    });
    if (!stored.command) throw new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
    if (stored.command.state === 'accepted') {
      try {
        await dispatchAccessCommand({
          repository,
          env: context.env,
          portalId: authorization.principal.portalId,
          commandId: input.commandId,
        });
      } catch {
        console.error(JSON.stringify({
          event: 'access_command_initial_dispatch_failed',
          commandId: input.commandId,
          correlationId: context.get('correlationId'),
        }));
      }
    }
    return context.json(
      mapCommandReceipt(stored.command, stored.targets, preflight.mode),
      stored.command.state === 'accepted' ? 202 : 200,
    );
  });

  routes.get('/commands/:commandId', async (context) => {
    const authorization = await authorize(context);
    const commandId = idSchema.safeParse(context.req.param('commandId'));
    if (!commandId.success) throw new ApiHttpError(400, 'INVALID_REQUEST');
    const repository = dependencies.createRepository(context.env);
    const stored = await repository.readCommand({
      portalId: authorization.principal.portalId,
      commandId: commandId.data,
    });
    if (!stored.command || stored.command.actor_user_id !== authorization.principal.userId) {
      throw new ApiHttpError(404, 'NOT_FOUND');
    }
    const preflight = await repository.readPreflight({
      portalId: authorization.principal.portalId,
      preflightId: stored.command.preflight_id,
    });
    if (!preflight.preflight) throw new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
    if (stored.command.state === 'accepted') {
      try {
        await dispatchAccessCommand({
          repository,
          env: context.env,
          portalId: authorization.principal.portalId,
          commandId: commandId.data,
        });
      } catch {
        console.error(JSON.stringify({
          event: 'access_command_status_dispatch_failed',
          commandId: commandId.data,
          correlationId: context.get('correlationId'),
        }));
      }
    }
    return context.json(
      mapCommandReceipt(
        stored.command,
        stored.targets,
        preflight.preflight.mode as AccessManagementCommandReceipt['mode'],
      ),
    );
  });

  return routes;
}
