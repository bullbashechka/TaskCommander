import {
  appPermissions,
  bitrixIdSchema,
  effectiveAccessResponseSchema,
  fieldIdSchema,
  operationIdSchema,
  permissionSchema,
  portalIdSchema,
  type EffectiveAccessResponse,
  type FieldScope,
  type Permission,
  type SessionPrincipal,
} from '@task-commander/contracts';
import { z } from 'zod';

import { isVerifiedSessionPrincipal, type VerifiedSessionPrincipal } from '../auth/session-service';
import type { BitrixAdapter, BitrixFailure } from '../integrations/bitrix/contract';
import { DataAccessError } from './errors';

const effectiveAccessBrand = Symbol('effectiveAccess');
const dataAccessContextBrand = Symbol('dataAccessContext');
const systemConsumerContextBrand = Symbol('systemConsumerContext');
const effectiveAccessCapabilities = new WeakSet<object>();
const dataAccessContextCapabilities = new WeakSet<object>();
const systemConsumerContextCapabilities = new WeakSet<object>();

const canonicalPersistedFieldIdSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value === value.trim());

const effectiveAccessSettingsSchema = z
  .object({
    accessActive: z.boolean(),
    permissions: z
      .array(permissionSchema)
      .max(appPermissions.length)
      .refine((permissions) => new Set(permissions).size === permissions.length),
    allowedFieldIds: z
      .array(canonicalPersistedFieldIdSchema)
      .refine((fieldIds) => new Set(fieldIds).size === fieldIds.length),
    accessVersion: z.number().int().safe().positive(),
  })
  .strict();

const requestedFieldIdsSchema = z.array(fieldIdSchema);

const reportActionInputSchema = z
  .object({
    operationId: operationIdSchema,
    action: z.enum(['retry_operations', 'restore_operations']),
  })
  .strict();

const reportAuthorizationSchema = z.object({ ownerId: bitrixIdSchema }).strict();

export interface EffectiveAccess {
  readonly principal: SessionPrincipal;
  readonly permissions: readonly Permission[];
  readonly fieldScope: FieldScope;
  readonly accessVersion: number | null;
  readonly [effectiveAccessBrand]: true;
}

export interface DataAccessContext {
  readonly portalId: string;
  readonly actorId: string;
  readonly permissions: readonly Permission[];
  readonly isBitrixAdmin: boolean;
  readonly accessVersion: number | null;
  readonly [dataAccessContextBrand]: true;
}

export interface SystemConsumerContext {
  readonly portalId: string;
  readonly actorId: string;
  readonly [systemConsumerContextBrand]: true;
}

type AuthorizationContext = EffectiveAccess | DataAccessContext;

export interface EffectiveAccessSettingsReader {
  findEffectiveAccessSettings(
    input: Pick<SessionPrincipal, 'portalId' | 'userId'>,
  ): Promise<unknown | null>;
}

export type EffectiveAccessSettings = z.infer<typeof effectiveAccessSettingsSchema>;

export interface ReportAuthorizationReader {
  findReportAuthorization(input: {
    portalId: string;
    operationId: string;
  }): Promise<unknown | null>;
}

export type ReportActionPermission = 'retry_operations' | 'restore_operations';

export class EffectiveAccessError extends Error {
  public constructor(public readonly kind: 'forbidden' | 'not_found' | 'upstream_unavailable') {
    super(kind);
  }
}

function assertEffectiveAccess(value: unknown): asserts value is EffectiveAccess {
  if (typeof value !== 'object' || value === null || !effectiveAccessCapabilities.has(value)) {
    throw new EffectiveAccessError('forbidden');
  }
}

function assertAuthorizationContext(value: unknown): asserts value is AuthorizationContext {
  if (
    typeof value !== 'object' ||
    value === null ||
    (!effectiveAccessCapabilities.has(value) && !dataAccessContextCapabilities.has(value))
  ) {
    throw new EffectiveAccessError('forbidden');
  }
}

function freezePrincipal(principal: SessionPrincipal): SessionPrincipal {
  return Object.freeze({
    portalId: principal.portalId,
    userId: principal.userId,
    displayName: principal.displayName,
    isBitrixAdmin: principal.isBitrixAdmin,
  });
}

function freezeFieldScope(fieldScope: FieldScope): FieldScope {
  if (fieldScope.kind === 'all') {
    const allScope: FieldScope = { kind: 'all' };
    return Object.freeze(allScope);
  }
  const subsetScope: FieldScope = { kind: 'subset', fieldIds: [...fieldScope.fieldIds] };
  Object.freeze(subsetScope.fieldIds);
  return Object.freeze(subsetScope);
}

function asEffectiveAccess(
  principal: SessionPrincipal,
  permissions: readonly Permission[],
  fieldScope: FieldScope,
  accessVersion: number | null,
): EffectiveAccess {
  const access: EffectiveAccess = {
    principal: freezePrincipal(principal),
    permissions: Object.freeze([...permissions]),
    fieldScope: freezeFieldScope(fieldScope),
    accessVersion,
    [effectiveAccessBrand]: true,
  };
  Object.freeze(access);
  effectiveAccessCapabilities.add(access);
  return access;
}

/**
 * Resolves access only from a validated, signed session principal and a server-side settings row.
 * Any malformed persisted row denies access as a whole.
 */
export async function resolveEffectiveAccess(
  principal: VerifiedSessionPrincipal,
  reader: EffectiveAccessSettingsReader,
): Promise<EffectiveAccess> {
  if (!isVerifiedSessionPrincipal(principal)) {
    throw new EffectiveAccessError('forbidden');
  }
  if (principal.isBitrixAdmin) {
    return asEffectiveAccess(principal, appPermissions, { kind: 'all' }, null);
  }

  let rawSettings: unknown | null;
  try {
    rawSettings = await reader.findEffectiveAccessSettings({
      portalId: principal.portalId,
      userId: principal.userId,
    });
  } catch {
    throw new EffectiveAccessError('upstream_unavailable');
  }

  const parsed = effectiveAccessSettingsSchema.safeParse(rawSettings);
  if (!parsed.success || !parsed.data.accessActive) {
    throw new EffectiveAccessError('forbidden');
  }

  return asEffectiveAccess(
    principal,
    parsed.data.permissions,
    {
      kind: 'subset',
      fieldIds: parsed.data.allowedFieldIds,
    },
    parsed.data.accessVersion,
  );
}

export function createDataAccessContext(access: EffectiveAccess): DataAccessContext {
  assertEffectiveAccess(access);
  requirePermission(access, 'app_access');
  const context: DataAccessContext = {
    portalId: portalIdSchema.parse(access.principal.portalId),
    actorId: bitrixIdSchema.parse(access.principal.userId),
    permissions: Object.freeze([...access.permissions]),
    isBitrixAdmin: access.principal.isBitrixAdmin,
    accessVersion: access.accessVersion,
    [dataAccessContextBrand]: true,
  };
  Object.freeze(context);
  dataAccessContextCapabilities.add(context);
  return context;
}

/** Creates a worker-only capability without inheriting any user permissions. */
export function createSystemConsumerContext(
  portalId: string,
  actorId: string,
): SystemConsumerContext {
  const context: SystemConsumerContext = {
    portalId: portalIdSchema.parse(portalId),
    actorId: bitrixIdSchema.parse(actorId),
    [systemConsumerContextBrand]: true,
  };
  Object.freeze(context);
  systemConsumerContextCapabilities.add(context);
  return context;
}

export function hasPermission(context: AuthorizationContext, permission: Permission): boolean {
  assertAuthorizationContext(context);
  return context.permissions.includes(permission);
}

export function requirePermission(context: AuthorizationContext, permission: Permission): void {
  if (!hasPermission(context, permission)) {
    throw new EffectiveAccessError('forbidden');
  }
}

export function requireAllPermissions(
  context: AuthorizationContext,
  permissions: readonly Permission[],
): void {
  assertAuthorizationContext(context);
  for (const permission of permissions) {
    requirePermission(context, permission);
  }
}

export function getEffectiveAccessResponse(access: EffectiveAccess): EffectiveAccessResponse {
  assertEffectiveAccess(access);
  return effectiveAccessResponseSchema.parse({
    permissions: access.permissions,
    fieldScope: access.fieldScope,
  });
}

/** Rejects a forged repository context before any tenant data can be addressed. */
export function requireDataAccessContext(context: DataAccessContext): void {
  try {
    if (
      typeof context !== 'object' ||
      context === null ||
      !dataAccessContextCapabilities.has(context)
    ) {
      throw new EffectiveAccessError('forbidden');
    }
    requirePermission(context, 'app_access');
  } catch (error) {
    if (error instanceof EffectiveAccessError) {
      throw new DataAccessError('UNAVAILABLE_RECORD', false);
    }
    throw error;
  }
}

/** Rejects user and forged contexts at worker-only repository transitions. */
export function requireSystemConsumerContext(context: SystemConsumerContext): void {
  if (
    typeof context !== 'object' ||
    context === null ||
    !systemConsumerContextCapabilities.has(context)
  ) {
    throw new DataAccessError('UNAVAILABLE_RECORD', false);
  }
}

export async function requireReportAction(
  access: EffectiveAccess,
  reader: ReportAuthorizationReader,
  input: { operationId: string; action: ReportActionPermission },
): Promise<void> {
  assertEffectiveAccess(access);
  const parsedInput = reportActionInputSchema.safeParse(input);
  if (!parsedInput.success) {
    throw new EffectiveAccessError('not_found');
  }
  requireAllPermissions(access, ['app_access', parsedInput.data.action]);

  let rawAuthorization: unknown | null;
  try {
    rawAuthorization = await reader.findReportAuthorization({
      portalId: access.principal.portalId,
      operationId: parsedInput.data.operationId,
    });
  } catch {
    throw new EffectiveAccessError('upstream_unavailable');
  }
  if (rawAuthorization === null) {
    throw new EffectiveAccessError('not_found');
  }

  const authorization = reportAuthorizationSchema.safeParse(rawAuthorization);
  if (!authorization.success) {
    throw new EffectiveAccessError('upstream_unavailable');
  }
  if (authorization.data.ownerId !== access.principal.userId) {
    requirePermission(access, 'view_all_reports');
  }
}

function toFieldAuthorizationError(failure: BitrixFailure): EffectiveAccessError {
  switch (failure.kind) {
    case 'not_found_or_forbidden':
      return new EffectiveAccessError('not_found');
    case 'permission_denied':
    case 'not_authenticated':
      return new EffectiveAccessError('forbidden');
    case 'rate_limited':
    case 'temporary_failure':
    case 'permanent_failure':
    case 'invalid_external_response':
    case 'unsupported_capability':
      return new EffectiveAccessError('upstream_unavailable');
  }
}

function parseRequestedFieldIds(value: unknown): string[] {
  const parsed = requestedFieldIdsSchema.safeParse(value);
  if (!parsed.success || parsed.data.length === 0) {
    throw new EffectiveAccessError('forbidden');
  }
  return [...new Set(parsed.data)];
}

export async function requireAuthorizedTaskFields(
  access: EffectiveAccess,
  adapter: BitrixAdapter,
  input: { taskId: string; fieldIds: unknown },
): Promise<readonly string[]> {
  assertEffectiveAccess(access);
  requireAllPermissions(access, ['app_access', 'change_allowed_fields']);

  const taskId = bitrixIdSchema.safeParse(input.taskId);
  if (!taskId.success) {
    throw new EffectiveAccessError('not_found');
  }
  const fieldIds = parseRequestedFieldIds(input.fieldIds);

  if (access.fieldScope.kind === 'subset') {
    const allowedFieldIds = access.fieldScope.fieldIds;
    if (!fieldIds.every((fieldId) => allowedFieldIds.includes(fieldId))) {
      throw new EffectiveAccessError('forbidden');
    }
  }

  let currentUser: Awaited<ReturnType<BitrixAdapter['users']['getCurrent']>>;
  try {
    currentUser = await adapter.users.getCurrent();
  } catch {
    throw new EffectiveAccessError('upstream_unavailable');
  }
  if (!currentUser.ok) {
    throw toFieldAuthorizationError(currentUser.failure);
  }
  if (!currentUser.value.isActive || currentUser.value.id !== access.principal.userId) {
    throw new EffectiveAccessError('forbidden');
  }

  let result: Awaited<ReturnType<BitrixAdapter['tasks']['readForChange']>>;
  try {
    result = await adapter.tasks.readForChange({ taskId: taskId.data, fieldIds });
  } catch {
    throw new EffectiveAccessError('upstream_unavailable');
  }
  if (!result.ok) {
    throw toFieldAuthorizationError(result.failure);
  }
  if (!fieldIds.every((fieldId) => result.value.editableFieldIds.includes(fieldId))) {
    throw new EffectiveAccessError('forbidden');
  }
  return fieldIds;
}

/** Converts an authorization failure to the repository's existing safe error boundary. */
export function requireRepositoryPermission(
  context: DataAccessContext,
  permission: Permission,
): void {
  requireDataAccessContext(context);
  try {
    requirePermission(context, permission);
  } catch (error) {
    if (error instanceof EffectiveAccessError) {
      throw new DataAccessError('UNAVAILABLE_RECORD', false);
    }
    throw error;
  }
}
