import { z } from 'zod';

import { createServerSupabaseClient } from '../data/client';
import type { RuntimeEnvironment } from '../runtime/configuration';

const executionSchema = z
  .object({
    operation: z
      .object({
        id: z.string().uuid(),
        portal_id: z.string(),
        initiator_id: z.string(),
        status: z.string(),
        launch_attempt: z.number().int().positive(),
        cancel_requested_at: z.string().datetime({ offset: true }).nullable(),
        interruption_requested_at: z.string().datetime({ offset: true }).nullable(),
        idempotency_key: z.string(),
        preflight_snapshot: z
          .object({
            draftId: z.string().uuid(),
            draftRevision: z.number().int().positive(),
          })
          .passthrough(),
      })
      .passthrough(),
    plan: z
      .object({
        ciphertext: z.string(),
        nonce: z.string(),
        keyVersion: z.string(),
        payloadVersion: z.number().int().positive(),
      })
      .strict(),
    access: z
      .object({
        active: z.boolean(),
        version: z.number().int().positive(),
        permissions: z.array(z.string()),
        allowedFieldIds: z.array(z.string()),
      })
      .strict()
      .nullable(),
  })
  .strict();

const claimSchema = z
  .object({
    claim_id: z.string().uuid(),
    phase: z.enum(['prepared', 'writing', 'applied', 'done']),
    before_version: z.string().nullable(),
    before_mutation_version: z.number().int().nonnegative().nullable(),
    after_mutation_version: z.number().int().positive().nullable(),
    applied_field_ids: z.array(z.string()),
    lease_until: z.string().datetime({ offset: true }),
  })
  .passthrough();

const claimResponseSchema = z
  .object({
    disposition: z.enum(['stale', 'done', 'busy', 'claimed', 'reconcile']),
    claim: claimSchema.optional(),
  })
  .strict();

const recordResponseSchema = z
  .object({
    inserted: z.boolean(),
    rejected: z.boolean().optional(),
    reasonCode: z.string().optional(),
  })
  .passthrough();

const dispatchSchema = z
  .object({
    operation_id: z.string().uuid(),
    portal_id: z.string(),
    launch_attempt: z.number().int().positive(),
    message_id: z.string().uuid(),
    created_at: z.string().datetime({ offset: true }),
  })
  .passthrough();

export type StoredExecution = z.infer<typeof executionSchema>;
export type TaskClaim = z.infer<typeof claimSchema>;
type ConsumerRpc = (
  name: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

export class OperationConsumerRepository {
  private readonly rpc: ConsumerRpc;

  public constructor(env: RuntimeEnvironment) {
    const client = createServerSupabaseClient(env);
    this.rpc = client.rpc.bind(client) as unknown as ConsumerRpc;
  }

  private async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await this.rpc(name, args);
    if (error) throw new Error(`Operation consumer ${name} failed.`);
    return data;
  }

  public async readExecution(portalId: string, operationId: string, launchAttempt: number) {
    const value = await this.call('read_operation_execution', {
      p_portal_id: portalId,
      p_operation_id: operationId,
      p_launch_attempt: launchAttempt,
    });
    return value === null ? null : executionSchema.parse(value);
  }

  public async claimStalledExecutions(limit: number) {
    return z.array(dispatchSchema).parse(
      await this.call('claim_stalled_operation_executions', {
        p_limit: limit,
      }),
    );
  }

  public async reserveRateSlot(portalId: string, operationId: string, launchAttempt: number) {
    const value = await this.call('reserve_operation_api_slot', {
      p_portal_id: portalId,
      p_operation_id: operationId,
      p_launch_attempt: launchAttempt,
    });
    return value === null ? null : z.number().int().nonnegative().parse(value);
  }

  public async claim(portalId: string, operationId: string, launchAttempt: number, taskId: string) {
    return claimResponseSchema.parse(
      await this.call('claim_operation_task', {
        p_portal_id: portalId,
        p_operation_id: operationId,
        p_launch_attempt: launchAttempt,
        p_task_id: taskId,
        p_claim_id: crypto.randomUUID(),
      }),
    );
  }

  public async readClaim(portalId: string, operationId: string, taskId: string) {
    const value = await this.call('read_operation_task_claim', {
      p_portal_id: portalId,
      p_operation_id: operationId,
      p_task_id: taskId,
    });
    return value === null ? null : claimSchema.parse(value);
  }

  public async release(portalId: string, operationId: string, taskId: string, claimId: string) {
    return z.boolean().parse(
      await this.call('release_prepared_operation_task', {
        p_portal_id: portalId,
        p_operation_id: operationId,
        p_task_id: taskId,
        p_claim_id: claimId,
      }),
    );
  }

  public async releaseRateLimited(
    portalId: string,
    operationId: string,
    taskId: string,
    claimId: string,
  ) {
    return z.boolean().parse(
      await this.call('release_rate_limited_operation_task', {
        p_portal_id: portalId,
        p_operation_id: operationId,
        p_task_id: taskId,
        p_claim_id: claimId,
      }),
    );
  }

  public async markWriting(input: {
    portalId: string;
    operationId: string;
    launchAttempt: number;
    taskId: string;
    claimId: string;
    beforeVersion: string;
    beforeMutationVersion: number;
    actorAccessVersion: number | null;
    requiredFieldIds: string[];
    protectedResult: {
      ciphertext: string;
      nonce: string;
      keyVersion: string;
      payloadVersion: number;
    };
  }) {
    return z.boolean().parse(
      await this.call('mark_operation_task_writing', {
        p_portal_id: input.portalId,
        p_operation_id: input.operationId,
        p_launch_attempt: input.launchAttempt,
        p_task_id: input.taskId,
        p_claim_id: input.claimId,
        p_before_version: input.beforeVersion,
        p_before_mutation_version: input.beforeMutationVersion,
        p_actor_access_version: input.actorAccessVersion,
        p_required_field_ids: input.requiredFieldIds,
        p_ciphertext: input.protectedResult.ciphertext,
        p_nonce: input.protectedResult.nonce,
        p_key_version: input.protectedResult.keyVersion,
        p_payload_version: input.protectedResult.payloadVersion,
      }),
    );
  }

  public async record(input: {
    portalId: string;
    operationId: string;
    launchAttempt: number;
    taskId: string;
    claimId: string;
    title: string | null;
    taskUrl: string | null;
    outcome: 'success' | 'error' | 'unconfirmed' | 'conflict' | 'partially_applied';
    requestedFieldIds: string[];
    appliedFieldIds: string[];
    failedFieldIds: string[];
    reasonCode: string | null;
    reasonMessage: string | null;
    correlationId: string;
    canRetry: boolean;
    afterVersion?: string;
  }) {
    const result = recordResponseSchema.parse(
      await this.call('record_claimed_task_result', {
        p_portal_id: input.portalId,
        p_operation_id: input.operationId,
        p_launch_attempt: input.launchAttempt,
        p_task_id: input.taskId,
        p_claim_id: input.claimId,
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
        p_after_version: input.afterVersion ?? null,
      }),
    );
    if (result.rejected) throw new Error(`Task result rejected: ${result.reasonCode ?? 'unknown'}`);
    return result;
  }
}
