import {
  auditActionSchema,
  auditEventSchema,
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
  type Permission,
  type TaskOutcome,
  type UserAccess,
} from '@task-commander/contracts';
import { type SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import { hasPermission, requirePermission, type DataAccessContext } from './access';
import { createNextCursor, resolvePageRequest, type CursorPage, type PageRequest } from './cursor';
import type { Database, DatabaseTable, Json } from './database.types';
import { DataAccessError, toDataAccessError } from './errors';

type Client = SupabaseClient<Database>;
type OperationRow = DatabaseTable<'bulk_operation'>;
type TaskResultRow = DatabaseTable<'task_processing_result'>;
type AuditRow = DatabaseTable<'audit_event'>;
type AuditEvent = z.infer<typeof auditEventSchema>;

const recordTaskResultResponseSchema = z
  .object({
    inserted: z.boolean(),
    result: z.record(z.unknown()),
    summary: z
      .object({
        successful: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        conflicted: z.number().int().nonnegative(),
        partiallyApplied: z.number().int().nonnegative(),
        notProcessed: z.number().int().nonnegative(),
      })
      .strict(),
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
    conflicted: number;
    partiallyApplied: number;
    notProcessed: number;
  };
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
  summary: Pick<
    BulkOperation['summary'],
    'selected' | 'eligible' | 'excluded' | 'unchanged'
  >;
}

function scopeKey(context: DataAccessContext, mode: 'own' | 'all' | 'audit'): string {
  return `${mode}:${context.portalId}:${context.actorId}`;
}

function hasAllReportVisibility(context: DataAccessContext): boolean {
  return hasPermission(context, 'view_all_reports');
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
    initiatorId: row.initiator_id,
    sourceOperationId: row.source_operation_id,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    summary: {
      selected: row.selected_count,
      eligible: row.eligible_count,
      excluded: row.excluded_count,
      unchanged: row.unchanged_count,
      successful: row.successful_count,
      failed: row.failed_count,
      conflicted: row.conflicted_count,
      partiallyApplied: row.partially_applied_count,
      notProcessed: row.not_processed_count,
    },
  });
}

function mapTaskOutcome(row: TaskResultRow): TaskOutcome {
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
  });
}

function mapAuditEvent(row: AuditRow): AuditEvent {
  return auditEventSchema.parse({
    id: row.id,
    occurredAt: row.occurred_at,
    action: auditActionSchema.parse(row.action),
    actorId: row.actor_id,
    subjectId: row.subject_id,
    outcome: row.outcome,
    correlationId: row.correlation_id,
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

  public async getCurrentUserAccess(context: DataAccessContext): Promise<UserAccess> {
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

  public async listSavedFilters(context: DataAccessContext): Promise<SavedFilter[]> {
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
  ): Promise<BulkOperation> {
    const row = await requireData(
      this.client
        .from('bulk_operation')
        .insert({
          portal_id: context.portalId,
          operation_type: input.type,
          initiator_id: context.actorId,
          initiator_display_name: input.initiatorDisplayName,
          source_operation_id: input.sourceOperationId,
          idempotency_key: input.idempotencyKey,
          filter_snapshot: input.filterSnapshot,
          selected_task_ids: input.selectedTaskIds,
          changes: input.changes,
          preflight_snapshot: input.preflightSnapshot,
          selected_count: input.summary.selected,
          eligible_count: input.summary.eligible,
          excluded_count: input.summary.excluded,
          unchanged_count: input.summary.unchanged,
        })
        .select('*')
        .single(),
    );
    return mapOperation(row);
  }

  public async getOperation(context: DataAccessContext, operationId: string): Promise<BulkOperation> {
    let query = this.client
      .from('bulk_operation')
      .select('*')
      .eq('portal_id', context.portalId)
      .eq('id', operationId);

    if (!hasAllReportVisibility(context)) {
      query = query.eq('initiator_id', context.actorId);
    }

    const row = await requireData(query.maybeSingle());
    return mapOperation(row);
  }

  public async transitionOperationStatus(
    context: DataAccessContext,
    input: {
      operationId: string;
      expectedStatuses: BulkOperation['status'][];
      nextStatus: BulkOperation['status'];
      markStarted?: boolean;
      touchProgress?: boolean;
      markCompleted?: boolean;
    },
  ): Promise<BulkOperation> {
    const currentOperation = await this.getOperation(context, input.operationId);
    const row = await requireData(
      this.client.rpc('transition_bulk_operation_status', {
        p_portal_id: context.portalId,
        p_operation_id: currentOperation.id,
        p_expected_statuses: input.expectedStatuses,
        p_next_status: input.nextStatus,
        p_mark_started: input.markStarted ?? false,
        p_touch_progress: input.touchProgress ?? false,
        p_mark_completed: input.markCompleted ?? false,
      }),
    );
    return mapOperation(row);
  }

  public async listOperationHistory(
    context: DataAccessContext,
    request: PageRequest = {},
  ): Promise<CursorPage<BulkOperation>> {
    const visibility = hasAllReportVisibility(context) ? 'all' : 'own';
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
    const operation = await this.getOperation(context, input.operationId);
    const protectedResult = input.protectedResult;
    const payload = await requireData(
      this.client.rpc('record_task_processing_result', {
        p_portal_id: context.portalId,
        p_operation_id: operation.id,
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
    const resultRow = taskResultRowSchema.parse(parsed.result);

    return {
      inserted: parsed.inserted,
      result: mapTaskOutcome(resultRow),
      summary: parsed.summary,
    };
  }

  public async listTaskResults(
    context: DataAccessContext,
    operationId: string,
  ): Promise<TaskOutcome[]> {
    const operation = await this.getOperation(context, operationId);
    const rows = await requireData(
      this.client
        .from('task_processing_result')
        .select('*')
        .eq('operation_id', operation.id)
        .order('created_at', { ascending: true }),
    );
    return rows.map(mapTaskOutcome);
  }

  public async getReportByOperation(
    context: DataAccessContext,
    operationId: string,
  ): Promise<ReportSummary> {
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
    requirePermission(context, 'view_audit');
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
