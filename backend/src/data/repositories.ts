import {
  parseAuditEventForRead,
  type AuditEvent,
  bulkOperationDraftSchema,
  bulkOperationSchema,
  operationStatusSchema,
  operationTypeSchema,
  permissionSchema,
  taskOutcomeSchema,
  taskOutcomeStatusSchema,
  userAccessSchema,
  type BulkOperation,
  type BulkOperationDraft,
  type TaskOutcome,
  type TaskOutcomeRefinement,
  type UserAccess,
} from '@task-commander/contracts';
import { type SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import {
  hasPermission,
  requireDataAccessContext,
  requireRepositoryPermission,
  type DataAccessContext,
} from './access';
import { createNextCursor, resolvePageRequest, type CursorPage, type PageRequest } from './cursor';
import type { Database, DatabaseTable, Json } from './database.types';
import { DataAccessError, toDataAccessError } from './errors';

type Client = SupabaseClient<Database>;
type OperationRow = DatabaseTable<'bulk_operation'>;
type TaskResultRow = DatabaseTable<'task_processing_result'>;
type AuditRow = DatabaseTable<'audit_event'>;
const taskResultRefinementBatchSize = 100;

const recordTaskResultResponseSchema = z
  .object({
    inserted: z.boolean(),
    rejected: z.boolean().optional(),
    reasonCode: z.string().trim().min(1).max(128).optional(),
    result: z.record(z.unknown()).optional(),
    summary: z
      .object({
        successful: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        unconfirmed: z.number().int().nonnegative(),
        conflicted: z.number().int().nonnegative(),
        partiallyApplied: z.number().int().nonnegative(),
        notProcessed: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();

const taskResultRefinementRowSchema = z
  .object({
    id: z.string().uuid(),
    source_task_processing_result_id: z.string().uuid(),
    outcome: z.enum([
      'success',
      'error',
      'conflict',
      'restored',
      'restore_error',
      'partially_applied',
    ]),
    applied_field_ids: z.array(z.string().trim().min(1).max(128)).max(256),
    failed_field_ids: z.array(z.string().trim().min(1).max(128)).max(256),
    reason_code: z.string().trim().min(1).max(128).nullable(),
    reason_message: z.string().trim().min(1).max(512).nullable(),
    can_retry: z.boolean(),
    result_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    before_version: z.string().trim().min(1).max(256).nullable(),
    after_version: z.string().trim().min(1).max(256).nullable(),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();

const operationCommandResponseSchema = z
  .object({
    disposition: z.enum([
      'created',
      'existing',
      'active_operation',
      'applied',
      'already_applied',
      'rejected',
    ]),
    operation: z.record(z.unknown()).optional(),
    reasonCode: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

const taskResultRowSchema = z
  .object({
    id: z.string().uuid(),
    operation_id: z.string().uuid(),
    task_id: z.string().trim().min(1).max(32),
    task_title: z.string().trim().min(1).max(1024).nullable(),
    task_url: z.string().url().nullable(),
    outcome: taskOutcomeStatusSchema,
    requested_field_ids: z.array(z.string().trim().min(1).max(128)).max(256),
    applied_field_ids: z.array(z.string().trim().min(1).max(128)).max(256),
    failed_field_ids: z.array(z.string().trim().min(1).max(128)).max(256),
    reason_code: z.string().trim().min(1).max(128).nullable(),
    reason_message: z.string().trim().min(1).max(512).nullable(),
    correlation_id: z.string().trim().min(1).max(128).nullable(),
    can_retry: z.boolean(),
    result_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict();

const reportSummarySchema = z
  .object({
    id: z.string().uuid(),
    operationId: z.string().uuid(),
    storageStatus: z.enum(['active', 'archived', 'archived_pending_artifact']),
    activeUntil: z.string().datetime({ offset: true }),
    archivedAt: z.string().datetime({ offset: true }).nullable(),
    deleteAfter: z.string().datetime({ offset: true }),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type ReportSummary = z.infer<typeof reportSummarySchema>;

export interface SavedFilter {
  id: string;
  name: string;
  revision: number;
  filterPayload: Json;
  createdAt: string;
  updatedAt: string;
}

export interface EncryptedProtectedResult {
  ciphertext: string;
  nonce: string;
  keyVersion: string;
  payloadVersion: number;
  beforeVersion: string;
  afterVersion: string;
}

export interface RecordTaskResultInput {
  operationId: string;
  launchAttempt: number;
  taskId: string;
  title: string | null;
  taskUrl: string | null;
  outcome: TaskOutcome['outcome'];
  requestedFieldIds: string[];
  appliedFieldIds: string[];
  failedFieldIds: string[];
  reasonCode: string | null;
  reasonMessage: string | null;
  correlationId: string | null;
  canRetry: boolean;
  protectedResult?: EncryptedProtectedResult;
}

export interface RecordedTaskResult {
  inserted: boolean;
  result: TaskOutcome;
  summary: {
    successful: number;
    failed: number;
    unconfirmed: number;
    conflicted: number;
    partiallyApplied: number;
    notProcessed: number;
  };
}

export interface RecordTaskResultRefinementInput {
  operationId: string;
  taskId: string;
  outcome: TaskOutcomeRefinement['outcome'];
  appliedFieldIds: string[];
  failedFieldIds: string[];
  reasonCode: string | null;
  reasonMessage: string | null;
  correlationId: string;
  canRetry: boolean;
  beforeVersion: string | null;
  afterVersion: string | null;
}

export interface CreateOperationInput {
  type: BulkOperation['type'];
  initiatorDisplayName: string;
  sourceOperationId: string | null;
  idempotencyKey: string;
  filterSnapshot: Json | null;
  selectedTaskIds: string[];
  changes: Json;
  preflightSnapshot: Json;
  summary: Pick<BulkOperation['summary'], 'selected' | 'eligible' | 'excluded' | 'unchanged'>;
  correlationId: string;
  initialResults?: InitialTaskResult[];
}

export interface InitialTaskResult {
  taskId: string;
  title: string | null;
  taskUrl: string | null;
  outcome: 'excluded_by_preflight' | 'no_change';
  requestedFieldIds: string[];
  reasonCode: string | null;
  reasonMessage: string | null;
}

export interface CreatedOperation {
  disposition: 'created' | 'existing' | 'active_operation';
  operation: BulkOperation;
}

export interface OperationCommandResult {
  disposition: 'applied' | 'already_applied';
  operation: BulkOperation;
}

function scopeKey(context: DataAccessContext, mode: 'own' | 'all' | 'audit'): string {
  return `${mode}:${context.portalId}:${context.actorId}`;
}

export function getReportVisibility(context: DataAccessContext): 'own' | 'all' {
  requireDataAccessContext(context);
  if (hasPermission(context, 'view_all_reports')) {
    return 'all';
  }
  requireRepositoryPermission(context, 'view_own_reports');
  return 'own';
}

async function requireData<T>(
  response: PromiseLike<{ data: T | null; error: unknown | null }>,
): Promise<T> {
  const { data, error } = await response;
  if (error) {
    throw toDataAccessError(error);
  }
  if (data === null) {
    throw new DataAccessError('UNAVAILABLE_RECORD', false);
  }
  return data;
}

function mapOperation(row: OperationRow): BulkOperation {
  return bulkOperationSchema.parse({
    id: row.id,
    type: operationTypeSchema.parse(row.operation_type),
    status: operationStatusSchema.parse(row.status),
    stateVersion: row.state_version,
    launchAttempt: row.launch_attempt,
    initiatorId: row.initiator_id,
    sourceOperationId: row.source_operation_id,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    cancelRequestedAt: row.cancel_requested_at,
    interruptionRequestedAt: row.interruption_requested_at,
    interruptionReasonCode: row.interruption_reason_code,
    summary: {
      selected: row.selected_count,
      eligible: row.eligible_count,
      excluded: row.excluded_count,
      unchanged: row.unchanged_count,
      successful: row.successful_count,
      failed: row.failed_count,
      unconfirmed: row.unconfirmed_count,
      conflicted: row.conflicted_count,
      partiallyApplied: row.partially_applied_count,
      notProcessed: row.not_processed_count,
    },
  });
}

function toOperationCommandError(reasonCode: string | undefined): DataAccessError {
  if (reasonCode === 'IDEMPOTENCY_PAYLOAD_MISMATCH') {
    return new DataAccessError('IDEMPOTENCY_MISMATCH', false);
  }
  if (reasonCode === 'OPERATION_UNAVAILABLE') {
    return new DataAccessError('UNAVAILABLE_RECORD', false);
  }
  if (reasonCode === 'TASK_RESULT_CONFLICT' || reasonCode === 'TASK_RESULT_REFINEMENT_CONFLICT') {
    return new DataAccessError('TASK_RESULT_MISMATCH', false);
  }
  if (reasonCode === 'ACTIVE_OPERATION') {
    return new DataAccessError('ACTIVE_OPERATION', false);
  }
  return new DataAccessError('INVALID_OPERATION_STATE', false);
}

function parseOperationCommand(payload: unknown): {
  disposition: z.infer<typeof operationCommandResponseSchema>['disposition'];
  operation?: BulkOperation;
  reasonCode?: string;
} {
  const parsed = operationCommandResponseSchema.parse(payload);
  return {
    disposition: parsed.disposition,
    operation: parsed.operation ? mapOperation(parsed.operation as OperationRow) : undefined,
    reasonCode: parsed.reasonCode,
  };
}

function mapTaskOutcome(
  row: TaskResultRow,
  refinement: TaskOutcomeRefinement | null = null,
): TaskOutcome {
  return taskOutcomeSchema.parse({
    taskId: row.task_id,
    title: row.task_title,
    taskUrl: row.task_url,
    outcome: taskOutcomeStatusSchema.parse(row.outcome),
    changedFieldIds: row.requested_field_ids,
    appliedFieldIds: row.applied_field_ids,
    failedFieldIds: row.failed_field_ids,
    reasonCode: row.reason_code,
    reasonMessage: row.reason_message,
    canRetry: row.can_retry,
    refinement,
  });
}

function mapTaskOutcomeRefinement(
  row: z.infer<typeof taskResultRefinementRowSchema>,
): TaskOutcomeRefinement {
  return {
    outcome: row.outcome,
    appliedFieldIds: row.applied_field_ids,
    failedFieldIds: row.failed_field_ids,
    reasonCode: row.reason_code,
    reasonMessage: row.reason_message,
    canRetry: row.can_retry,
    refinedAt: row.created_at,
  };
}

function mapAuditEvent(row: AuditRow): AuditEvent {
  return parseAuditEventForRead({
    id: row.id,
    schemaVersion: row.schema_version,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    action: row.action,
    actor:
      row.actor_type === 'user'
        ? { type: 'user', id: row.actor_id, displayName: row.actor_display_name }
        : { type: 'system', source: row.actor_source, displayName: row.actor_display_name },
    subject: {
      type: row.subject_type,
      id: row.subject_id,
      displayName: row.subject_display_name,
    },
    relatedObjects: row.related_objects,
    outcome: row.outcome,
    correlationId: row.correlation_id,
    details: row.details,
  });
}

function mapSavedFilter(row: DatabaseTable<'saved_filter'>): SavedFilter {
  return {
    id: row.id,
    name: row.name,
    revision: row.revision,
    filterPayload: row.filter_payload,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDraft(row: DatabaseTable<'operation_draft'>): BulkOperationDraft {
  return bulkOperationDraftSchema.parse({
    id: row.id,
    ownerId: row.owner_id,
    revision: row.revision,
    status: row.status,
    selectedTaskIds: row.selected_task_ids,
    changes: row.changes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  });
}

export class TaskCommanderRepositories {
  public constructor(private readonly client: Client) {}

  private async getOwnedOperation(
    context: DataAccessContext,
    operationId: string,
  ): Promise<BulkOperation> {
    requireDataAccessContext(context);
    const row = await requireData(
      this.client
        .from('bulk_operation')
        .select('*')
        .eq('portal_id', context.portalId)
        .eq('initiator_id', context.actorId)
        .eq('id', operationId)
        .maybeSingle(),
    );
    return mapOperation(row);
  }

  public async getCurrentUserAccess(context: DataAccessContext): Promise<UserAccess> {
    requireDataAccessContext(context);
    const row = await requireData(
      this.client
        .from('user_settings')
        .select('*')
        .eq('portal_id', context.portalId)
        .eq('user_id', context.actorId)
        .maybeSingle(),
    );

    return userAccessSchema.parse({
      user: { id: row.user_id, displayName: row.display_name, isActive: row.access_active },
      permissions: row.permissions.map((permission) => permissionSchema.parse(permission)),
      allowedFieldIds: row.allowed_field_ids,
      grantedAt: row.granted_at,
      updatedAt: row.updated_at,
      grantedByUserId: row.granted_by_user_id,
    });
  }

  public async findEffectiveAccessSettings(input: {
    portalId: string;
    userId: string;
  }): Promise<unknown | null> {
    const { data, error } = await this.client
      .from('user_settings')
      .select('access_active, permissions, allowed_field_ids')
      .eq('portal_id', input.portalId)
      .eq('user_id', input.userId)
      .maybeSingle();

    if (error) {
      throw toDataAccessError(error);
    }
    if (data === null) {
      return null;
    }

    return {
      accessActive: data.access_active,
      permissions: data.permissions,
      allowedFieldIds: data.allowed_field_ids,
    };
  }

  public async findReportAuthorization(input: {
    portalId: string;
    operationId: string;
  }): Promise<{ ownerId: string } | null> {
    const { data, error } = await this.client
      .from('bulk_operation')
      .select('initiator_id')
      .eq('portal_id', input.portalId)
      .eq('id', input.operationId)
      .maybeSingle();

    if (error) {
      throw toDataAccessError(error);
    }
    return data === null ? null : { ownerId: data.initiator_id };
  }

  public async listSavedFilters(context: DataAccessContext): Promise<SavedFilter[]> {
    requireDataAccessContext(context);
    const rows = await requireData(
      this.client
        .from('saved_filter')
        .select('*')
        .eq('portal_id', context.portalId)
        .eq('owner_id', context.actorId)
        .order('normalized_name', { ascending: true }),
    );
    return rows.map(mapSavedFilter);
  }

  public async createSavedFilter(
    context: DataAccessContext,
    input: { name: string; filterPayload: Json },
  ): Promise<SavedFilter> {
    requireDataAccessContext(context);
    const row = await requireData(
      this.client
        .from('saved_filter')
        .insert({
          portal_id: context.portalId,
          owner_id: context.actorId,
          name: input.name,
          filter_payload: input.filterPayload,
        })
        .select('*')
        .single(),
    );
    return mapSavedFilter(row);
  }

  public async updateSavedFilter(
    context: DataAccessContext,
    input: { id: string; expectedRevision: number; name: string; filterPayload: Json },
  ): Promise<SavedFilter> {
    requireDataAccessContext(context);
    const { data, error } = await this.client
      .from('saved_filter')
      .update({
        name: input.name,
        filter_payload: input.filterPayload,
        revision: input.expectedRevision + 1,
      })
      .eq('id', input.id)
      .eq('portal_id', context.portalId)
      .eq('owner_id', context.actorId)
      .eq('revision', input.expectedRevision)
      .select('*');

    if (error) {
      throw toDataAccessError(error);
    }
    if (!data || data.length !== 1) {
      throw new DataAccessError('CONFLICT', false);
    }

    const row = data[0];
    return mapSavedFilter(row);
  }

  public async deleteSavedFilter(
    context: DataAccessContext,
    input: { id: string; expectedRevision: number },
  ): Promise<void> {
    requireDataAccessContext(context);
    const { error, count } = await this.client
      .from('saved_filter')
      .delete({ count: 'exact' })
      .eq('id', input.id)
      .eq('portal_id', context.portalId)
      .eq('owner_id', context.actorId)
      .eq('revision', input.expectedRevision);

    if (error) {
      throw toDataAccessError(error);
    }
    if (count !== 1) {
      throw new DataAccessError('UNAVAILABLE_RECORD', false);
    }
  }

  public async getCurrentDraft(context: DataAccessContext): Promise<BulkOperationDraft> {
    requireDataAccessContext(context);
    const row = await requireData(
      this.client
        .from('operation_draft')
        .select('*')
        .eq('portal_id', context.portalId)
        .eq('owner_id', context.actorId)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle(),
    );
    return mapDraft(row);
  }

  public async saveDraft(
    context: DataAccessContext,
    input: {
      expectedRevision: number;
      status: BulkOperationDraft['status'];
      filterSnapshot: Json | null;
      sortSnapshot: Json | null;
      selectedTaskIds: string[];
      changes: Json;
      preflightSnapshot: Json | null;
      replaceExpired?: boolean;
    },
  ): Promise<BulkOperationDraft> {
    requireDataAccessContext(context);
    const row = await requireData(
      this.client.rpc('save_operation_draft', {
        p_portal_id: context.portalId,
        p_owner_id: context.actorId,
        p_expected_revision: input.expectedRevision,
        p_status: input.status,
        p_filter_snapshot: input.filterSnapshot,
        p_sort_snapshot: input.sortSnapshot,
        p_selected_task_ids: input.selectedTaskIds,
        p_changes: input.changes,
        p_preflight_snapshot: input.preflightSnapshot,
        p_replace_expired: input.replaceExpired ?? false,
      }),
    );
    return mapDraft(row);
  }

  public async createOperation(
    context: DataAccessContext,
    input: CreateOperationInput,
  ): Promise<CreatedOperation> {
    requireDataAccessContext(context);
    const payload = await requireData(
      this.client.rpc('create_bulk_operation_idempotent', {
        p_portal_id: context.portalId,
        p_operation_type: input.type,
        p_initiator_id: context.actorId,
        p_initiator_display_name: input.initiatorDisplayName,
        p_source_operation_id: input.sourceOperationId,
        p_idempotency_key: input.idempotencyKey,
        p_filter_snapshot: input.filterSnapshot,
        p_selected_task_ids: input.selectedTaskIds,
        p_changes: input.changes,
        p_preflight_snapshot: input.preflightSnapshot,
        p_selected_count: input.summary.selected,
        p_eligible_count: input.summary.eligible,
        p_excluded_count: input.summary.excluded,
        p_unchanged_count: input.summary.unchanged,
        p_correlation_id: input.correlationId,
        p_initial_results: (input.initialResults ?? []).map((result) => ({
          taskId: result.taskId,
          title: result.title,
          taskUrl: result.taskUrl,
          outcome: result.outcome,
          requestedFieldIds: result.requestedFieldIds,
          reasonCode: result.reasonCode,
          reasonMessage: result.reasonMessage,
        })) as Json,
      }),
    );
    const result = parseOperationCommand(payload);
    if (result.disposition === 'rejected' || !result.operation) {
      throw toOperationCommandError(result.reasonCode);
    }
    return {
      disposition: result.disposition as CreatedOperation['disposition'],
      operation: result.operation,
    };
  }

  public async getOperation(
    context: DataAccessContext,
    operationId: string,
  ): Promise<BulkOperation> {
    requireDataAccessContext(context);
    const visibility = getReportVisibility(context);
    let query = this.client
      .from('bulk_operation')
      .select('*')
      .eq('portal_id', context.portalId)
      .eq('id', operationId);

    if (visibility === 'own') {
      query = query.eq('initiator_id', context.actorId);
    }

    const row = await requireData(query.maybeSingle());
    return mapOperation(row);
  }

  public async startOperation(
    context: DataAccessContext,
    input: { operationId: string; launchAttempt: number; correlationId: string },
  ): Promise<OperationCommandResult> {
    requireDataAccessContext(context);
    const currentOperation = await this.getOwnedOperation(context, input.operationId);
    const payload = await requireData(
      this.client.rpc('start_bulk_operation_with_attempt', {
        p_portal_id: context.portalId,
        p_operation_id: currentOperation.id,
        p_expected_launch_attempt: input.launchAttempt,
        p_correlation_id: input.correlationId,
      }),
    );
    return this.resolveOperationCommand(payload);
  }

  public async requestOperationCancellation(
    context: DataAccessContext,
    input: { operationId: string; correlationId: string },
  ): Promise<OperationCommandResult> {
    requireDataAccessContext(context);
    return this.requestOperationStop(context, { ...input, kind: 'cancel' });
  }

  public async requestOperationInterruption(
    context: DataAccessContext,
    input: {
      operationId: string;
      launchAttempt: number;
      correlationId: string;
      reasonCode: string;
      reasonMessage: string;
    },
  ): Promise<OperationCommandResult> {
    requireDataAccessContext(context);
    const operation = await this.getOwnedOperation(context, input.operationId);
    const payload = await requireData(
      this.client.rpc('request_bulk_operation_interruption_with_attempt', {
        p_portal_id: context.portalId,
        p_operation_id: operation.id,
        p_expected_launch_attempt: input.launchAttempt,
        p_reason_code: input.reasonCode,
        p_reason_message: input.reasonMessage,
        p_correlation_id: input.correlationId,
      }),
    );
    return this.resolveOperationCommand(payload);
  }

  public async finalizeOperation(
    context: DataAccessContext,
    input: { operationId: string; launchAttempt: number; correlationId: string },
  ): Promise<OperationCommandResult> {
    requireDataAccessContext(context);
    const operation = await this.getOwnedOperation(context, input.operationId);
    const payload = await requireData(
      this.client.rpc('finalize_bulk_operation_with_attempt', {
        p_portal_id: context.portalId,
        p_operation_id: operation.id,
        p_expected_launch_attempt: input.launchAttempt,
        p_correlation_id: input.correlationId,
      }),
    );
    return this.resolveOperationCommand(payload);
  }

  public async failOperationLaunch(
    context: DataAccessContext,
    input: { operationId: string; launchAttempt: number; correlationId: string },
  ): Promise<OperationCommandResult> {
    requireDataAccessContext(context);
    const operation = await this.getOwnedOperation(context, input.operationId);
    const payload = await requireData(
      this.client.rpc('fail_bulk_operation_launch_with_attempt', {
        p_portal_id: context.portalId,
        p_operation_id: operation.id,
        p_expected_launch_attempt: input.launchAttempt,
        p_correlation_id: input.correlationId,
      }),
    );
    return this.resolveOperationCommand(payload);
  }

  public async retryOperationLaunch(
    context: DataAccessContext,
    input: { operationId: string; correlationId: string },
  ): Promise<OperationCommandResult> {
    requireDataAccessContext(context);
    const operation = await this.getOwnedOperation(context, input.operationId);
    const payload = await requireData(
      this.client.rpc('retry_bulk_operation_launch', {
        p_portal_id: context.portalId,
        p_operation_id: operation.id,
        p_correlation_id: input.correlationId,
      }),
    );
    return this.resolveOperationCommand(payload);
  }

  private async requestOperationStop(
    context: DataAccessContext,
    input: { operationId: string; correlationId: string; kind: 'cancel' },
  ): Promise<OperationCommandResult> {
    const operation = await this.getOwnedOperation(context, input.operationId);
    const payload = await requireData(
      this.client.rpc('request_bulk_operation_cancellation', {
        p_portal_id: context.portalId,
        p_operation_id: operation.id,
        p_correlation_id: input.correlationId,
      }),
    );
    return this.resolveOperationCommand(payload);
  }

  private resolveOperationCommand(payload: unknown): OperationCommandResult {
    const result = parseOperationCommand(payload);
    if (result.disposition === 'rejected' || !result.operation) {
      throw toOperationCommandError(result.reasonCode);
    }
    if (result.disposition !== 'applied' && result.disposition !== 'already_applied') {
      throw new DataAccessError('INVALID_OPERATION_STATE', false);
    }
    return { disposition: result.disposition, operation: result.operation };
  }

  public async listOperationHistory(
    context: DataAccessContext,
    request: PageRequest = {},
  ): Promise<CursorPage<BulkOperation>> {
    requireDataAccessContext(context);
    const visibility = getReportVisibility(context);
    const scope = scopeKey(context, visibility);
    const page = resolvePageRequest(request, 'operation-history', scope);
    let query = this.client
      .from('bulk_operation')
      .select('*')
      .eq('portal_id', context.portalId)
      .lte('created_at', page.asOf)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(page.limit + 1);

    if (visibility === 'own') {
      query = query.eq('initiator_id', context.actorId);
    }
    if (page.before) {
      query = query.or(
        `created_at.lt.${page.before.timestamp},and(created_at.eq.${page.before.timestamp},id.lt.${page.before.id})`,
      );
    }

    const rows = await requireData(query);
    const visibleRows = rows.slice(0, page.limit);
    const lastRow = visibleRows.at(-1);
    return {
      items: visibleRows.map(mapOperation),
      nextCursor:
        rows.length > page.limit && lastRow
          ? createNextCursor('operation-history', scope, page.asOf, lastRow.created_at, lastRow.id)
          : null,
    };
  }

  public async recordTaskResult(
    context: DataAccessContext,
    input: RecordTaskResultInput,
  ): Promise<RecordedTaskResult> {
    requireDataAccessContext(context);
    const operation = await this.getOwnedOperation(context, input.operationId);
    const protectedResult = input.protectedResult;
    const payload = await requireData(
      this.client.rpc('record_task_processing_result_with_attempt', {
        p_portal_id: context.portalId,
        p_operation_id: operation.id,
        p_expected_launch_attempt: input.launchAttempt,
        p_task_id: input.taskId,
        p_task_title: input.title,
        p_task_url: input.taskUrl,
        p_outcome: input.outcome,
        p_requested_field_ids: input.requestedFieldIds,
        p_applied_field_ids: input.appliedFieldIds,
        p_failed_field_ids: input.failedFieldIds,
        p_reason_code: input.reasonCode,
        p_reason_message: input.reasonMessage,
        p_correlation_id: input.correlationId,
        p_can_retry: input.canRetry,
        p_protected_ciphertext: protectedResult?.ciphertext ?? null,
        p_protected_nonce: protectedResult?.nonce ?? null,
        p_protected_key_version: protectedResult?.keyVersion ?? null,
        p_protected_payload_version: protectedResult?.payloadVersion ?? null,
        p_before_version: protectedResult?.beforeVersion ?? null,
        p_after_version: protectedResult?.afterVersion ?? null,
      }),
    );
    const parsed = recordTaskResultResponseSchema.parse(payload);
    if (parsed.rejected || !parsed.result || !parsed.summary) {
      throw toOperationCommandError(parsed.reasonCode);
    }
    const resultRow = taskResultRowSchema.parse(parsed.result);

    return {
      inserted: parsed.inserted,
      result: mapTaskOutcome(resultRow),
      summary: parsed.summary,
    };
  }

  public async recordTaskResultRefinement(
    context: DataAccessContext,
    input: RecordTaskResultRefinementInput,
  ): Promise<{ inserted: boolean; refinement: TaskOutcomeRefinement }> {
    requireDataAccessContext(context);
    const operation = await this.getOwnedOperation(context, input.operationId);
    const payload = await requireData(
      this.client.rpc('record_task_result_refinement_with_versions', {
        p_portal_id: context.portalId,
        p_operation_id: operation.id,
        p_task_id: input.taskId,
        p_outcome: input.outcome,
        p_applied_field_ids: input.appliedFieldIds,
        p_failed_field_ids: input.failedFieldIds,
        p_reason_code: input.reasonCode,
        p_reason_message: input.reasonMessage,
        p_correlation_id: input.correlationId,
        p_can_retry: input.canRetry,
        p_before_version: input.beforeVersion,
        p_after_version: input.afterVersion,
      }),
    );
    const parsed = z
      .object({
        inserted: z.boolean(),
        rejected: z.boolean().optional(),
        reasonCode: z.string().trim().min(1).max(128).optional(),
        refinement: taskResultRefinementRowSchema.optional(),
      })
      .strict()
      .parse(payload);
    if (parsed.rejected || !parsed.refinement) {
      throw toOperationCommandError(parsed.reasonCode);
    }
    return { inserted: parsed.inserted, refinement: mapTaskOutcomeRefinement(parsed.refinement) };
  }

  public async listTaskResults(
    context: DataAccessContext,
    operationId: string,
  ): Promise<TaskOutcome[]> {
    requireDataAccessContext(context);
    const operation = await this.getOperation(context, operationId);
    const rows = await requireData(
      this.client
        .from('task_processing_result')
        .select('*')
        .eq('operation_id', operation.id)
        .order('created_at', { ascending: true }),
    );
    const resultIds = rows.map((row) => row.id);
    const refinementBatches = await Promise.all(
      Array.from(
        { length: Math.ceil(resultIds.length / taskResultRefinementBatchSize) },
        (_, batchIndex) =>
          requireData(
            this.client
              .from('task_result_refinement')
              .select('*')
              .in(
                'source_task_processing_result_id',
                resultIds.slice(
                  batchIndex * taskResultRefinementBatchSize,
                  (batchIndex + 1) * taskResultRefinementBatchSize,
                ),
              ),
          ),
      ),
    );
    const refinements = refinementBatches.flat();
    const refinementsBySource = new Map(
      refinements.map((refinement) => [
        refinement.source_task_processing_result_id,
        mapTaskOutcomeRefinement(taskResultRefinementRowSchema.parse(refinement)),
      ]),
    );
    return rows.map((row) => mapTaskOutcome(row, refinementsBySource.get(row.id) ?? null));
  }

  public async getReportByOperation(
    context: DataAccessContext,
    operationId: string,
  ): Promise<ReportSummary> {
    requireDataAccessContext(context);
    const operation = await this.getOperation(context, operationId);
    const row = await requireData(
      this.client.from('report').select('*').eq('operation_id', operation.id).maybeSingle(),
    );
    return reportSummarySchema.parse({
      id: row.id,
      operationId: row.operation_id,
      storageStatus: row.storage_status,
      activeUntil: row.active_until,
      archivedAt: row.archived_at,
      deleteAfter: row.delete_after,
      createdAt: row.created_at,
    });
  }

  public async listAuditEvents(
    context: DataAccessContext,
    request: PageRequest = {},
  ): Promise<CursorPage<AuditEvent>> {
    requireDataAccessContext(context);
    requireRepositoryPermission(context, 'view_audit');
    const scope = scopeKey(context, 'audit');
    const page = resolvePageRequest(request, 'audit-events', scope);
    let query = this.client
      .from('audit_event')
      .select('*')
      .eq('portal_id', context.portalId)
      .lte('occurred_at', page.asOf)
      .order('occurred_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(page.limit + 1);

    if (page.before) {
      query = query.or(
        `occurred_at.lt.${page.before.timestamp},and(occurred_at.eq.${page.before.timestamp},id.lt.${page.before.id})`,
      );
    }

    const rows = await requireData(query);
    const visibleRows = rows.slice(0, page.limit);
    const lastRow = visibleRows.at(-1);
    return {
      items: visibleRows.map(mapAuditEvent),
      nextCursor:
        rows.length > page.limit && lastRow
          ? createNextCursor('audit-events', scope, page.asOf, lastRow.occurred_at, lastRow.id)
          : null,
    };
  }
}
