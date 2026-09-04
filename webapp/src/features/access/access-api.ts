import {
  accessManagementCommandReceiptSchema,
  accessManagementConfirmationSchema,
  accessManagementDraftIntentSchema,
  accessManagementDraftSaveResponseSchema,
  accessEmployeeProfileSchema,
  accessEmployeeSearchResponseSchema,
  accessFieldSetMembersResponseSchema,
  accessManagementPreflightSchema,
  correlationIdSchema,
  permissionSchema,
  type Permission,
} from '@task-commander/contracts';

import { notifySecurityContextInvalidated } from '@/app/access-sync';

import type {
  AccessCapabilities,
  AccessCommand,
  AccessConfirmation,
  AccessDraft,
  AccessField,
  AccessPreflight,
  AccessUser,
  Department,
  UsersPage,
} from './access-types';

const basePath = '/api/access-management';
let terminalSecurityInvalidationPending = false;

export class AccessApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly eventId?: string,
  ) {
    super(message);
  }
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${basePath}${path}`, {
      ...init,
      headers: { accept: 'application/json', 'content-type': 'application/json', ...init?.headers },
    });
  } catch {
    throw new AccessApiError('Не удалось подключиться к серверу. Повторите попытку позже.', 0);
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const record = isRecord(payload) ? payload : {};
    const error = isRecord(record.error) ? record.error : record;
    const code = typeof error.code === 'string' ? error.code : undefined;
    if (
      !terminalSecurityInvalidationPending &&
      (response.status === 401 || code === 'ACCESS_REVOKED')
    ) {
      terminalSecurityInvalidationPending = true;
      notifySecurityContextInvalidated();
    }
    const eventId = correlationIdSchema.safeParse(error.correlationId ?? error.eventId);
    throw new AccessApiError(
      'Не удалось безопасно получить данные доступа.',
      response.status,
      eventId.success ? eventId.data : undefined,
    );
  }
  terminalSecurityInvalidationPending = false;
  return payload;
}

export function accessErrorMessage(error: unknown, fallback: string): string {
  return error instanceof AccessApiError ? error.message : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function permissionArray(value: unknown): Permission[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = permissionSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function parseUser(value: unknown): AccessUser | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id ?? value.userId);
  const displayName = stringValue(value.displayName ?? value.name);
  if (!id || !displayName) return null;
  const rawStatus = value.accessState ?? value.status;
  const status = rawStatus === 'active'
    ? 'active'
    : rawStatus === 'quarantined'
      ? 'quarantined'
      : rawStatus === 'review_required' || rawStatus === 'review'
        ? 'review'
        : rawStatus === 'revoked' || rawStatus === 'none'
          ? 'none'
          : 'review';
  const departmentPaths = Array.isArray(value.departmentPaths) ? value.departmentPaths : [];
  const departmentPath = departmentPaths.find(Array.isArray);
  const employmentValue = value.employmentState ?? value.employmentStatus;
  const employmentState = employmentValue === 'active' || employmentValue === 'inactive'
    ? employmentValue
    : 'unknown';
  const fieldScopeValue = isRecord(value.fieldScope) ? value.fieldScope : null;
  const fieldScope = fieldScopeValue?.kind === 'all'
    ? { kind: 'all' as const }
    : fieldScopeValue?.kind === 'set' && typeof fieldScopeValue.fieldSetId === 'string' &&
        typeof fieldScopeValue.version === 'number' && typeof fieldScopeValue.count === 'number' &&
        typeof fieldScopeValue.fingerprint === 'string'
      ? {
          kind: 'set' as const,
          fieldSetId: fieldScopeValue.fieldSetId,
          version: fieldScopeValue.version,
          count: fieldScopeValue.count,
          fingerprint: fieldScopeValue.fingerprint,
        }
      : null;
  return {
    id,
    displayName,
    position: stringValue(value.position ?? value.jobTitle, 'Сотрудник'),
    department: stringValue(value.department ?? value.departmentName, Array.isArray(departmentPath) ? departmentPath.filter((item): item is string => typeof item === 'string').join(' / ') : 'Без подразделения'),
    avatarUrl: typeof (value.avatarUrl ?? value.photoUrl) === 'string' ? String(value.avatarUrl ?? value.photoUrl) : undefined,
    status,
    permissionCount: typeof value.permissionCount === 'number' ? value.permissionCount : stringArray(value.permissions).length,
    permissions: permissionArray(value.permissions),
    isBitrixAdmin: value.isBitrixAdmin === true || value.isAdministrator === true,
    isManager: value.isManager === true,
    isSelf: value.isSelf === true,
    employmentState,
    canManage: value.canManage !== false && value.isSelf !== true &&
      value.isBitrixAdmin !== true && value.isAdministrator !== true && employmentState === 'active',
    attentionReason: typeof value.attentionReason === 'string'
      ? value.attentionReason
      : rawStatus === undefined ? 'Настройки доступа требуют загрузки' : undefined,
    accessVersion: typeof value.accessVersion === 'number' ? value.accessVersion : null,
    fieldScope,
    availableModes: [],
  };
}

export async function fetchCapabilities(): Promise<AccessCapabilities> {
  const payload = await request('/capabilities');
  if (!isRecord(payload)) throw new AccessApiError('API вернул неожиданный ответ.', 500);
  const actor = isRecord(payload.actor) ? payload.actor : {};
  const permissions = permissionArray(
    payload.delegablePermissions ?? payload.manageablePermissions ?? payload.managedPermissions ?? payload.permissions,
  );
  return {
    canManageAccess: payload.canManageAccess === true || permissions.length > 0,
    canGrantManageAccess: payload.canGrantManageAccess === true || actor.isAdministrator === true,
    isAdmin: payload.isAdmin === true || actor.isAdministrator === true,
    permissions,
    bitrixCheckedAt: typeof payload.bitrixCheckedAt === 'string' ? payload.bitrixCheckedAt : null,
    permissionCatalogVersion: typeof (payload.permissionCatalogVersion ?? payload.permissionMatrixVersion) === 'number' ? Number(payload.permissionCatalogVersion ?? payload.permissionMatrixVersion) : 1,
    actorAccessVersion: typeof payload.actorAccessVersion === 'number' ? payload.actorAccessVersion : 1,
    actorUserId: stringValue(actor.id),
    degraded: payload.degraded === true,
  };
}

export async function fetchUsers(input: {
  q: string;
  status: string;
  cursor?: string | null;
}): Promise<UsersPage> {
  const search = new URLSearchParams();
  if (input.q) search.set('q', input.q);
  if (input.status !== 'all') search.set('status', input.status);
  if (input.cursor) search.set('cursor', input.cursor);
  const payload = accessEmployeeSearchResponseSchema.parse(
    await request(`/users?${search.toString()}`),
  );
  const items = payload.employees
    .map(parseUser)
    .filter((user): user is AccessUser => user !== null);
  return {
    items,
    total: items.length,
    nextCursor: payload.nextCursor,
  };
}

export async function fetchUser(id: string): Promise<AccessUser> {
  const record = accessEmployeeProfileSchema.parse(
    await request(`/users/${encodeURIComponent(id)}`),
  );
  const user = parseUser(record.employee);
  if (!user) throw new AccessApiError('API вернул неожиданный ответ.', 500);
  const access = record.access;
  const capabilities = record.capabilities;
  const accessWithScope = { ...user, fieldScope: access.fieldScope };
  const parsedAccessUser = parseUser(accessWithScope) ?? user;
  return {
    ...parsedAccessUser,
    permissionCount: access.permissions.length,
    permissions: access.permissions,
    accessVersion: access.settingsVersion,
    canManage: capabilities.canManage,
    availableModes: capabilities.availableModes,
  };
}

export async function fetchDepartments(): Promise<Department[]> {
  const payload = await request('/departments');
  const list = Array.isArray(payload) ? payload : isRecord(payload) && Array.isArray(payload.items) ? payload.items : [];
  return list.flatMap((value) => isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string' ? [{ id: value.id, name: value.name }] : []);
}

export async function createDepartmentSnapshot(departmentId: string): Promise<{
  subjectIds: string[];
  excludedCount: number;
}> {
  const payload = await request(`/department-snapshots/${encodeURIComponent(departmentId)}`, {
    method: 'POST',
  });
  if (!isRecord(payload)) return { subjectIds: [], excludedCount: 0 };
  const memberIds = stringArray(payload.subjectIds ?? payload.userIds ?? payload.memberIds);
  if (memberIds.length > 100) {
    throw new AccessApiError(
      'В подразделении больше 100 сотрудников. Выберите сотрудников через поиск.',
      400,
    );
  }
  return {
    subjectIds: memberIds,
    excludedCount: typeof payload.excludedCount === 'number' ? payload.excludedCount : 0,
  };
}

function fieldLabel(id: string): string {
  const known: Record<string, string> = {
    TITLE: 'Название', DESCRIPTION: 'Описание', RESPONSIBLE_ID: 'Ответственный',
    DEADLINE: 'Крайний срок', PRIORITY: 'Приоритет', TAGS: 'Теги', GROUP_ID: 'Проект',
  };
  return known[id] ?? id.replace(/^UF_[A-Z]+_/, '').replaceAll('_', ' ').toLocaleLowerCase('ru')
    .replace(/^./u, (letter) => letter.toLocaleUpperCase('ru'));
}

export async function fetchFields(q = ''): Promise<AccessField[]> {
  const result: AccessField[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const search = new URLSearchParams({ q, pageSize: '100' });
    if (cursor) search.set('cursor', cursor);
    const payload = await request(`/fields?${search.toString()}`);
    const record = isRecord(payload) ? payload : {};
    const list = Array.isArray(payload) ? payload : Array.isArray(record.items) ? record.items : [];
    result.push(...list.flatMap((value) => isRecord(value) && typeof value.id === 'string' && value.manageable !== false ? [{
      id: value.id,
      label: typeof value.label === 'string' ? value.label : fieldLabel(value.id),
      group: typeof value.group === 'string' ? value.group : typeof value.sourceType === 'string' ? value.sourceType : undefined,
    }] : []));
    const nextCursor = typeof record.nextCursor === 'string' ? record.nextCursor : null;
    if (nextCursor && seenCursors.has(nextCursor)) {
      throw new AccessApiError('Сервер повторил страницу каталога полей.', 502);
    }
    if (nextCursor) seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);
  return result;
}

export async function fetchFieldSetMembers(input: {
  fieldSetId: string;
  version: number;
  targetUserId: string;
}): Promise<string[]> {
  const fieldIds: string[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const search = new URLSearchParams({ version: String(input.version), limit: '100' });
    search.set('targetUserId', input.targetUserId);
    if (cursor) search.set('cursor', cursor);
    const parsed = accessFieldSetMembersResponseSchema.parse(
      await request(`/field-sets/${encodeURIComponent(input.fieldSetId)}/members?${search.toString()}`),
    );
    fieldIds.push(...parsed.fieldIds);
    if (parsed.nextCursor && seenCursors.has(parsed.nextCursor)) {
      throw new AccessApiError('Сервер повторил страницу набора полей.', 502);
    }
    if (parsed.nextCursor) seenCursors.add(parsed.nextCursor);
    cursor = parsed.nextCursor;
  } while (cursor);
  return fieldIds;
}

export async function saveDraft(draft: AccessDraft): Promise<AccessDraft> {
  const validated = accessManagementDraftIntentSchema.parse(draft);
  const saved = accessManagementDraftSaveResponseSchema.parse(
    await request('/draft', { method: 'PUT', body: JSON.stringify(validated) }),
  );
  return { ...validated, draftRevision: saved.revision };
}

export async function fetchDraftRevision(): Promise<number> {
  const payload = await request('/draft');
  if (!isRecord(payload) || typeof payload.revision !== 'number') {
    throw new AccessApiError('API вернул неожиданный статус черновика.', 500);
  }
  return payload.revision;
}

export async function createPreflight(draft: AccessDraft): Promise<AccessPreflight> {
  return parsePreflight(await request('/preflights', { method: 'POST', body: JSON.stringify(draft) }));
}

export async function fetchPreflight(id: string): Promise<AccessPreflight> {
  return parsePreflight(await request(`/preflights/${encodeURIComponent(id)}`));
}

function parsePreflight(payload: unknown): AccessPreflight {
  const parsed = accessManagementPreflightSchema.safeParse(payload);
  if (!parsed.success) throw new AccessApiError('API вернул неожиданный результат проверки.', 500);
  return parsed.data;
}

export async function confirmPreflight(
  preflight: AccessPreflight,
): Promise<AccessConfirmation | undefined> {
  if (!preflight.confirmation.required) return undefined;
  const payload = await request(`/preflights/${encodeURIComponent(preflight.preflightId)}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ preflightId: preflight.preflightId, draftRevision: preflight.draftRevision, confirmed: true }),
  });
  const parsed = accessManagementConfirmationSchema.safeParse(payload);
  if (!parsed.success) throw new AccessApiError('API вернул неожиданное подтверждение.', 500);
  if (!parsed.data.token) throw new AccessApiError('Подтверждение не содержит токен.', 500);
  return { id: parsed.data.confirmationId, token: parsed.data.token };
}

export async function createCommand(input: { commandId: string; preflightId: string; confirmationId?: string; confirmationToken?: string }): Promise<AccessCommand> {
  return parseCommand(await request('/commands', { method: 'POST', body: JSON.stringify(input) }));
}

export async function fetchCommand(id: string): Promise<AccessCommand> {
  return parseCommand(await request(`/commands/${encodeURIComponent(id)}`));
}

function parseCommand(payload: unknown): AccessCommand {
  const parsed = accessManagementCommandReceiptSchema.safeParse(payload);
  if (!parsed.success) throw new AccessApiError('API вернул неожиданный статус команды.', 500);
  return parsed.data;
}
