import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database, DatabaseTable, Json } from './database.types';
import { DataAccessError, toDataAccessError } from './errors';

type Client = SupabaseClient<Database>;

async function unwrap<T>(operation: PromiseLike<{ data: T; error: unknown }>): Promise<T> {
  const { data, error } = await operation;
  if (error) {
    throw toDataAccessError(error);
  }
  return data;
}

async function unwrapRequired<T>(
  operation: PromiseLike<{ data: T | null; error: unknown }>,
): Promise<T> {
  const data = await unwrap(operation);
  if (data === null) {
    throw new DataAccessError('INTEGRITY', false);
  }
  return data;
}

/** Service-role data boundary. Every read and RPC receives an explicit tenant identifier. */
export class AccessManagementRepository {
  public constructor(private readonly client: Client) {}

  public async findSettings(input: {
    portalId: string;
    userIds: readonly string[];
  }): Promise<DatabaseTable<'user_settings'>[]> {
    if (input.userIds.length === 0) {
      return [];
    }
    return unwrapRequired(
      this.client
        .from('user_settings')
        .select('*')
        .eq('portal_id', input.portalId)
        .in('user_id', [...input.userIds]),
    );
  }

  public async getFieldSetPage(input: {
    portalId: string;
    fieldSetId: string;
    afterOrdinal?: number;
    limit: number;
  }): Promise<DatabaseTable<'access_field_set_member'>[]> {
    const cappedLimit = Math.min(Math.max(input.limit, 1), 101);
    return unwrapRequired(
      this.client
        .from('access_field_set_member')
        .select('*')
        .eq('portal_id', input.portalId)
        .eq('field_set_id', input.fieldSetId)
        .gt('ordinal', input.afterOrdinal ?? 0)
        .order('ordinal', { ascending: true })
        .limit(cappedLimit),
    );
  }

  public async findFieldSets(input: {
    portalId: string;
    fieldSetIds: readonly string[];
  }): Promise<DatabaseTable<'access_field_set'>[]> {
    if (input.fieldSetIds.length === 0) return [];
    return unwrapRequired(
      this.client
        .from('access_field_set')
        .select('*')
        .eq('portal_id', input.portalId)
        .in('id', [...new Set(input.fieldSetIds)]),
    );
  }

  public async resolveFieldSet(portalId: string, fieldIds: readonly string[]): Promise<string> {
    return unwrapRequired(
      this.client.rpc('resolve_access_field_set', {
        p_portal_id: portalId,
        p_field_ids: [...fieldIds],
      }),
    );
  }

  public async saveDraftWithFieldSet(input: {
    portalId: string;
    managerUserId: string;
    expectedRevision: number;
    fieldIds: readonly string[];
    payload: Json;
  }): Promise<DatabaseTable<'access_management_draft'>> {
    return unwrapRequired(
      this.client.rpc('save_access_draft_with_field_set', {
        p_portal_id: input.portalId,
        p_manager_user_id: input.managerUserId,
        p_expected_revision: input.expectedRevision,
        p_field_ids: [...input.fieldIds],
        p_draft_payload: input.payload,
      }),
    );
  }

  public async consumeFilteredSearchLimit(portalId: string, actorUserId: string): Promise<void> {
    await unwrap(
      this.client.rpc('consume_access_management_read_limit', {
        p_portal_id: portalId,
        p_actor_user_id: actorUserId,
      }),
    );
  }

  public async readDraft(input: {
    portalId: string;
    managerUserId: string;
  }): Promise<DatabaseTable<'access_management_draft'> | null> {
    return unwrap(
      this.client
        .from('access_management_draft')
        .select('*')
        .eq('portal_id', input.portalId)
        .eq('manager_user_id', input.managerUserId)
        .maybeSingle(),
    );
  }

  public async createPreflight(input: {
    portalId: string;
    draftId: string;
    expectedDraftRevision: number;
    managerUserId: string;
    managerAccessVersion: number;
    permissionMatrixVersion: number;
    mode: string;
    requestFingerprint: string;
    summary: Json;
    targets: Json;
  }): Promise<Json> {
    return unwrap(
      this.client.rpc('create_access_preflight', {
        p_portal_id: input.portalId,
        p_draft_id: input.draftId,
        p_expected_draft_revision: input.expectedDraftRevision,
        p_manager_user_id: input.managerUserId,
        p_manager_access_version: input.managerAccessVersion,
        p_permission_matrix_version: input.permissionMatrixVersion,
        p_mode: input.mode,
        p_request_fingerprint: input.requestFingerprint,
        p_summary: input.summary,
        p_targets: input.targets,
      }),
    );
  }

  public async readPreflight(input: { portalId: string; preflightId: string }): Promise<{
    preflight: DatabaseTable<'access_preflight'> | null;
    targets: DatabaseTable<'access_preflight_target'>[];
  }> {
    const [preflight, targets] = await Promise.all([
      unwrap(
        this.client
          .from('access_preflight')
          .select('*')
          .eq('portal_id', input.portalId)
          .eq('id', input.preflightId)
          .maybeSingle(),
      ),
      unwrapRequired(
        this.client
          .from('access_preflight_target')
          .select('*')
          .eq('portal_id', input.portalId)
          .eq('preflight_id', input.preflightId)
          .order('target_user_id', { ascending: true }),
      ),
    ]);
    return { preflight, targets };
  }

  public async acceptCommand(input: {
    portalId: string;
    commandId: string;
    idempotencyKey: string;
    preflightId: string;
    actorUserId: string;
    actorDisplayName: string;
    actorIsPortalAdmin: boolean;
    confirmationId: string | null;
    correlationId: string;
  }): Promise<Json> {
    return unwrapRequired(
      this.client.rpc('accept_access_command', {
        p_portal_id: input.portalId,
        p_command_id: input.commandId,
        p_idempotency_key: input.idempotencyKey,
        p_preflight_id: input.preflightId,
        p_actor_user_id: input.actorUserId,
        p_actor_display_name: input.actorDisplayName,
        p_actor_is_portal_admin: input.actorIsPortalAdmin,
        p_confirmation_id: input.confirmationId,
        p_correlation_id: input.correlationId,
      }),
    );
  }

  public async claimCommand(portalId: string, commandId: string, expectedStateVersion: number) {
    return unwrapRequired(
      this.client.rpc('claim_access_command', {
        p_portal_id: portalId,
        p_command_id: commandId,
        p_expected_state_version: expectedStateVersion,
      }),
    );
  }

  public async applyCommandTarget(input: {
    portalId: string;
    commandId: string;
    expectedStateVersion: number;
    targetUserId: string;
    actorIsActive: boolean;
    actorIsPortalAdmin: boolean;
    actorIsManager: boolean;
    targetIsActive: boolean | null;
    targetIsManager: boolean;
    targetIsPortalAdmin: boolean;
  }): Promise<Json> {
    return unwrapRequired(
      this.client.rpc('apply_access_command_target', {
        p_portal_id: input.portalId,
        p_command_id: input.commandId,
        p_expected_state_version: input.expectedStateVersion,
        p_target_user_id: input.targetUserId,
        p_actor_is_active: input.actorIsActive,
        p_actor_is_portal_admin: input.actorIsPortalAdmin,
        p_actor_is_manager: input.actorIsManager,
        p_target_is_active: input.targetIsActive,
        p_target_is_manager: input.targetIsManager,
        p_target_is_portal_admin: input.targetIsPortalAdmin,
      }),
    );
  }

  public async finalizeCommand(portalId: string, commandId: string, expectedStateVersion: number) {
    return unwrapRequired(
      this.client.rpc('finalize_access_command', {
        p_portal_id: portalId,
        p_command_id: commandId,
        p_expected_state_version: expectedStateVersion,
      }),
    );
  }

  public async failCommand(
    portalId: string,
    commandId: string,
    expectedStateVersion: number,
    reasonCode: 'ACTOR_ACCESS_CHANGED' | 'PERMISSION_CATALOG_CHANGED' | 'INTERNAL_ERROR',
  ) {
    return unwrap(
      this.client.rpc('fail_access_command', {
        p_portal_id: portalId,
        p_command_id: commandId,
        p_expected_state_version: expectedStateVersion,
        p_reason_code: reasonCode,
      }),
    );
  }

  public async readCommand(input: { portalId: string; commandId: string }): Promise<{
    command: DatabaseTable<'access_command'> | null;
    targets: DatabaseTable<'access_command_target'>[];
  }> {
    const snapshot = await unwrap(
      this.client.rpc('read_access_command', {
        p_portal_id: input.portalId,
        p_command_id: input.commandId,
      }),
    );
    if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      return { command: null, targets: [] };
    }
    const record = snapshot as Record<string, unknown>;
    return {
      command: (record.command ?? null) as DatabaseTable<'access_command'> | null,
      targets: Array.isArray(record.targets)
        ? (record.targets as DatabaseTable<'access_command_target'>[])
        : [],
    };
  }

  public async listPendingCommandDispatches(
    limit = 100,
  ): Promise<DatabaseTable<'access_command_dispatch_outbox'>[]> {
    return unwrapRequired(
      this.client
        .from('access_command_dispatch_outbox')
        .select('*')
        .eq('status', 'pending')
        .lte('available_at', new Date().toISOString())
        .order('created_at', { ascending: true })
        .limit(Math.min(Math.max(limit, 1), 100)),
    );
  }

  public async listStaleCommands(
    before: string,
    limit = 100,
  ): Promise<DatabaseTable<'access_command'>[]> {
    const boundedLimit = Math.min(Math.max(limit, 1), 100);
    const [accepted, active] = await Promise.all([
      unwrapRequired(
        this.client
          .from('access_command')
          .select('*')
          .eq('state', 'accepted')
          .lt('accepted_at', before)
          .order('accepted_at', { ascending: true })
          .limit(boundedLimit),
      ),
      unwrapRequired(
        this.client
          .from('access_command')
          .select('*')
          .in('state', ['validating', 'in_progress'])
          .lt('started_at', before)
          .order('started_at', { ascending: true })
          .limit(boundedLimit),
      ),
    ]);
    return [...accepted, ...active]
      .sort((left, right) =>
        (left.started_at ?? left.accepted_at).localeCompare(right.started_at ?? right.accepted_at),
      )
      .slice(0, boundedLimit);
  }

  public async readCommandDispatch(
    portalId: string,
    commandId: string,
  ): Promise<DatabaseTable<'access_command_dispatch_outbox'> | null> {
    return unwrap(
      this.client
        .from('access_command_dispatch_outbox')
        .select('*')
        .eq('portal_id', portalId)
        .eq('command_id', commandId)
        .maybeSingle(),
    );
  }

  public async markCommandDispatched(portalId: string, commandId: string): Promise<void> {
    await unwrap(
      this.client
        .from('access_command_dispatch_outbox')
        .update({
          status: 'dispatched',
          dispatched_at: new Date().toISOString(),
        })
        .eq('portal_id', portalId)
        .eq('command_id', commandId)
        .eq('status', 'pending'),
    );
  }

  public async claimAutomaticAccessReconciliationJobs(
    leaseToken: string,
    limit = 100,
  ): Promise<{ portalId: string; userId: string }[]> {
    const rows = await unwrapRequired(
      this.client.rpc('claim_access_reconciliation_jobs', {
        p_lease_token: leaseToken,
        p_limit: Math.min(Math.max(limit, 1), 100),
      }),
    );
    return rows.map((row) => ({ portalId: row.portal_id, userId: row.user_id }));
  }

  public async recordAutomaticAccessReconciliationUnknown(input: {
    portalId: string;
    userId: string;
    leaseToken: string | null;
  }): Promise<void> {
    await unwrap(
      this.client.rpc('record_access_reconciliation_unknown', {
        p_portal_id: input.portalId,
        p_user_id: input.userId,
        p_lease_token: input.leaseToken,
      }),
    );
  }

  public async applyAutomaticAccessReconciliation(input: {
    portalId: string;
    userId: string;
    displayName: string;
    employmentState: 'active' | 'inactive' | 'missing';
    isManager: boolean;
    source: 'request' | 'cron' | 'queue';
    correlationId: string;
    leaseToken?: string | null;
  }): Promise<unknown> {
    return unwrap(
      this.client.rpc('apply_automatic_access_reconciliation', {
        p_portal_id: input.portalId,
        p_user_id: input.userId,
        p_display_name: input.displayName,
        p_employment_state: input.employmentState,
        p_is_manager: input.isManager,
        p_source: input.source,
        p_correlation_id: input.correlationId,
        p_lease_token: input.leaseToken ?? null,
      }),
    );
  }
}
