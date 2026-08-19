import type { Permission } from '@task-commander/contracts';

import type { VerifiedSessionPrincipal } from '../auth/session-service';
import {
  EffectiveAccessError,
  createDataAccessContext,
  hasPermission,
  type DataAccessContext,
  type EffectiveAccess,
} from '../data/access';
import type { BitrixAdapter, BitrixFailure } from '../integrations/bitrix/contract';

export interface AccessManagerAuthorization {
  readonly principal: VerifiedSessionPrincipal;
  readonly access: EffectiveAccess;
  readonly dataContext: DataAccessContext;
  readonly adapter: BitrixAdapter;
  readonly isAdministrator: boolean;
  readonly manageablePermissions: readonly Permission[];
}

function toAuthorizationError(failure: BitrixFailure): EffectiveAccessError {
  switch (failure.kind) {
    case 'not_authenticated':
    case 'permission_denied':
      return new EffectiveAccessError('forbidden');
    case 'not_found_or_forbidden':
      return new EffectiveAccessError('not_found');
    case 'rate_limited':
    case 'temporary_failure':
    case 'permanent_failure':
    case 'invalid_external_response':
    case 'unsupported_capability':
      return new EffectiveAccessError('upstream_unavailable');
  }
}

export async function authorizeAccessManager(input: {
  principal: VerifiedSessionPrincipal;
  access: EffectiveAccess;
  adapter: BitrixAdapter;
}): Promise<AccessManagerAuthorization> {
  let current: Awaited<ReturnType<BitrixAdapter['users']['getCurrent']>>;
  try {
    current = await input.adapter.users.getCurrent();
  } catch {
    throw new EffectiveAccessError('upstream_unavailable');
  }
  if (!current.ok) throw toAuthorizationError(current.failure);
  if (!current.value.isActive || current.value.id !== input.principal.userId) {
    throw new EffectiveAccessError('forbidden');
  }

  // A stale session must never preserve administrator authority after Bitrix removes it.
  if (input.principal.isBitrixAdmin !== current.value.isAdmin) {
    throw new EffectiveAccessError('forbidden');
  }

  const isAdministrator = current.value.isAdmin;
  if (!isAdministrator) {
    if (!hasPermission(input.access, 'manage_access')) {
      throw new EffectiveAccessError('forbidden');
    }
    let leadership: Awaited<ReturnType<BitrixAdapter['organization']['getLeadership']>>;
    try {
      leadership = await input.adapter.organization.getLeadership(input.principal.userId);
    } catch {
      throw new EffectiveAccessError('upstream_unavailable');
    }
    if (!leadership.ok) throw toAuthorizationError(leadership.failure);
    if (leadership.value.length === 0) throw new EffectiveAccessError('forbidden');
  }

  const manageablePermissions = input.access.permissions;
  return Object.freeze({
    principal: input.principal,
    access: input.access,
    dataContext: createDataAccessContext(input.access),
    adapter: input.adapter,
    isAdministrator,
    manageablePermissions: Object.freeze([...manageablePermissions]),
  });
}
