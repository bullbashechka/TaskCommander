import type { VerifiedSessionPrincipal } from '../auth/session-service';
import { refreshVerifiedSessionPrincipal } from '../auth/session-service';
import { createAccessManagementRepository, type AccessManagementRepository } from '../data';
import { createBitrixAdapter } from '../integrations/bitrix/factory';
import type { BitrixAdapter, BitrixFailure } from '../integrations/bitrix/contract';
import type { RuntimeEnvironment } from '../runtime/configuration';

export class CurrentIdentityError extends Error {
  public constructor(public readonly kind: 'revoked' | 'unauthenticated' | 'unavailable') {
    super(kind);
  }
}

function isTransientFailure(failure: BitrixFailure): boolean {
  return [
    'rate_limited',
    'temporary_failure',
    'permanent_failure',
    'invalid_external_response',
    'unsupported_capability',
  ].includes(failure.kind);
}

function hasCompleteStatusSnapshot(
  requestedUserIds: readonly string[],
  statuses: readonly {
    state: 'active' | 'inactive' | 'missing';
    user?: { id: string; isActive: boolean };
    userId?: string;
  }[],
): boolean {
  if (statuses.length !== requestedUserIds.length) return false;
  const requested = new Set(requestedUserIds);
  const observed = new Set<string>();
  for (const status of statuses) {
    const userId = status.state === 'missing' ? status.userId : status.user?.id;
    if (!userId || !requested.has(userId) || observed.has(userId)) return false;
    if (status.state !== 'missing' && status.user?.isActive !== (status.state === 'active')) {
      return false;
    }
    observed.add(userId);
  }
  return observed.size === requested.size;
}

async function applyObservation(
  repository: AccessManagementRepository,
  input: {
    portalId: string;
    userId: string;
    displayName: string;
    employmentState: 'active' | 'inactive' | 'missing';
    isManager: boolean;
    source: 'request' | 'cron' | 'queue';
    correlationId: string;
    leaseToken?: string | null;
  },
): Promise<void> {
  await repository.applyAutomaticAccessReconciliation(input);
}

/**
 * A signed cookie establishes identity only. This function establishes that the identity is still
 * active in Bitrix24 and persists a confirmed automatic revocation when it is not.
 */
export async function verifyCurrentSessionPrincipal(input: {
  env: RuntimeEnvironment;
  principal: VerifiedSessionPrincipal;
  adapter: BitrixAdapter;
  repository?: AccessManagementRepository;
  createRepository?: () => AccessManagementRepository;
  correlationId: string;
}): Promise<VerifiedSessionPrincipal> {
  let current: Awaited<ReturnType<BitrixAdapter['users']['getCurrent']>>;
  try {
    current = await input.adapter.users.getCurrent();
  } catch {
    throw new CurrentIdentityError('unavailable');
  }
  if (!current.ok) {
    if (
      current.failure.kind === 'not_authenticated' ||
      current.failure.kind === 'permission_denied'
    ) {
      throw new CurrentIdentityError('unauthenticated');
    }
    if (isTransientFailure(current.failure) || current.failure.kind === 'not_found_or_forbidden') {
      throw new CurrentIdentityError('unavailable');
    }
    throw new CurrentIdentityError('unavailable');
  }
  if (current.value.id !== input.principal.userId) {
    throw new CurrentIdentityError('unauthenticated');
  }
  if (!current.value.isActive) {
    try {
      const repository = input.repository ?? input.createRepository?.();
      if (repository) {
        await applyObservation(repository, {
          portalId: input.principal.portalId,
          userId: current.value.id,
          displayName: current.value.displayName,
          employmentState: 'inactive',
          isManager: false,
          source: 'request',
          correlationId: input.correlationId,
        });
      }
    } catch {
      // Bitrix24 already confirmed the user is inactive, so the current request must remain denied
      // even if the durable audit/revocation transaction will need a later Cron retry.
    }
    throw new CurrentIdentityError('revoked');
  }
  return refreshVerifiedSessionPrincipal(input.principal, {
    userId: current.value.id,
    displayName: current.value.displayName,
    isBitrixAdmin: current.value.isAdmin,
  });
}

export async function runAutomaticAccessReconciliation(
  env: RuntimeEnvironment,
  dependencies: {
    repository?: AccessManagementRepository;
    createAdapter?: (env: RuntimeEnvironment, input: { currentUserId?: string }) => BitrixAdapter;
    createLeaseToken?: () => string;
  } = {},
): Promise<{ checked: number; changed: number; unknown: number }> {
  const repository = dependencies.repository ?? createAccessManagementRepository(env);
  const createAdapter = dependencies.createAdapter ?? createBitrixAdapter;
  const createLeaseToken = dependencies.createLeaseToken ?? (() => crypto.randomUUID());
  const leaseToken = createLeaseToken();
  const jobs = await repository.claimAutomaticAccessReconciliationJobs(leaseToken, 100);
  if (jobs.length === 0) return { checked: 0, changed: 0, unknown: 0 };

  let checked = 0;
  let changed = 0;
  let unknown = 0;
  const byPortal = new Map<string, string[]>();
  for (const job of jobs) {
    const users = byPortal.get(job.portalId) ?? [];
    users.push(job.userId);
    byPortal.set(job.portalId, users);
  }

  for (const [portalId, userIds] of byPortal) {
    const currentUserId = userIds[0];
    if (!currentUserId) continue;
    const adapter = createAdapter(env, { currentUserId });
    let departments: Awaited<ReturnType<BitrixAdapter['organization']['getDepartments']>>;
    try {
      departments = await adapter.organization.getDepartments();
    } catch {
      departments = {
        ok: false,
        failure: { kind: 'temporary_failure', reasonCode: 'REQUEST_FAILED' },
      };
    }
    const managerIds = new Set(
      departments.ok
        ? departments.value.flatMap((department) =>
            department.headUserId === null ? [] : [department.headUserId],
          )
        : [],
    );

    for (let offset = 0; offset < userIds.length; offset += 50) {
      const chunk = userIds.slice(offset, offset + 50);
      let statuses: Awaited<ReturnType<BitrixAdapter['users']['getAccessStatuses']>>;
      try {
        statuses = await adapter.users.getAccessStatuses(chunk);
      } catch {
        statuses = {
          ok: false,
          failure: { kind: 'temporary_failure', reasonCode: 'REQUEST_FAILED' },
        };
      }
      const statusSnapshotIsComplete =
        statuses.ok && hasCompleteStatusSnapshot(chunk, statuses.value);
      if (!departments.ok || !statusSnapshotIsComplete) {
        for (const userId of chunk) {
          await repository.recordAutomaticAccessReconciliationUnknown({
            portalId,
            userId,
            leaseToken,
          });
          unknown += 1;
        }
        continue;
      }

      for (const status of statuses.value) {
        const userId = status.state === 'missing' ? status.userId : status.user.id;
        const displayName = status.state === 'missing' ? '' : status.user.displayName;
        const result = await repository.applyAutomaticAccessReconciliation({
          portalId,
          userId,
          displayName,
          employmentState: status.state,
          isManager: status.state === 'active' && managerIds.has(status.user.id),
          source: 'cron',
          correlationId: `TC-${crypto.randomUUID()}`,
          leaseToken,
        });
        checked += 1;
        if (
          typeof result === 'object' &&
          result !== null &&
          (result as Record<string, unknown>).disposition === 'applied'
        ) {
          changed += 1;
        }
      }
    }
  }
  return { checked, changed, unknown };
}
