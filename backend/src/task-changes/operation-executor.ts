import type { PreflightTaskEntry } from '@task-commander/contracts';

import type { OperationQueueMessage } from '../contracts/operation-queue';
import { createSystemConsumerContext } from '../data/access';
import { createTaskCommanderRepositories, type TaskCommanderRepositories } from '../data';
import type {
  BitrixAdapter,
  BitrixFailure,
  TaskChangeSnapshot,
} from '../integrations/bitrix/contract';
import { createBitrixAdapter } from '../integrations/bitrix/factory';
import type { RuntimeEnvironment } from '../runtime/configuration';
import { getRequiredQueueBinding } from '../runtime/configuration';
import { decryptExecutionPlan, encryptPreviousValues } from './execution-plan';
import { OperationConsumerRepository, type TaskClaim } from './operation-consumer-repository';

class RetryableOperationError extends Error {}

type ConsumerStore = Pick<
  OperationConsumerRepository,
  | 'readExecution'
  | 'reserveRateSlot'
  | 'claim'
  | 'readClaim'
  | 'release'
  | 'releaseRateLimited'
  | 'markWriting'
  | 'record'
  | 'acquireExecutionLease'
  | 'renewExecutionLease'
  | 'releaseExecutionLease'
>;
type OperationTransitions = Pick<
  TaskCommanderRepositories,
  'startOperation' | 'requestOperationInterruption' | 'finalizeOperation'
>;

function retryable(failure: BitrixFailure): boolean {
  return failure.kind === 'rate_limited' || failure.kind === 'temporary_failure';
}

function matchesTarget(snapshot: TaskChangeSnapshot, entry: PreflightTaskEntry): boolean {
  return entry.changedFieldIds.every(
    (fieldId) =>
      JSON.stringify(snapshot.values[fieldId]) === JSON.stringify(entry.targetValues?.[fieldId]),
  );
}

function confirmedOutcome(
  snapshot: TaskChangeSnapshot,
  entry: PreflightTaskEntry,
  claim: TaskClaim,
): 'success' | 'partially_applied' | null {
  if (matchesTarget(snapshot, entry)) return 'success';
  if (
    claim.applied_field_ids.length > 0 &&
    claim.applied_field_ids.every(
      (fieldId) =>
        entry.changedFieldIds.includes(fieldId) &&
        JSON.stringify(snapshot.values[fieldId]) === JSON.stringify(entry.targetValues?.[fieldId]),
    ) &&
    entry.changedFieldIds.every(
      (fieldId) =>
        claim.applied_field_ids.includes(fieldId) ||
        JSON.stringify(snapshot.values[fieldId]) === JSON.stringify(entry.currentValues?.[fieldId]),
    )
  ) {
    return 'partially_applied';
  }
  return null;
}

function readFieldIds(changes: readonly { fieldId: string }[]): string[] {
  const fields = changes.map((change) => change.fieldId);
  if (fields.includes('start_date') || fields.includes('deadline')) {
    if (!fields.includes('start_date')) fields.push('start_date');
    if (!fields.includes('deadline')) fields.push('deadline');
  }
  return fields;
}

function accessIsCurrent(
  execution: Awaited<ReturnType<OperationConsumerRepository['readExecution']>>,
  accessVersion: number | null,
  fieldIds: readonly string[],
): boolean {
  if (!execution) return false;
  if (accessVersion === null) return true;
  const access = execution.access;
  return Boolean(
    access?.active &&
    access.version === accessVersion &&
    ['app_access', 'run_bulk_operations', 'change_allowed_fields'].every((permission) =>
      access.permissions.includes(permission),
    ) &&
    fieldIds.every((fieldId) => access.allowedFieldIds.includes(fieldId)),
  );
}

export async function executeOperationMessage(input: {
  env: RuntimeEnvironment;
  message: OperationQueueMessage;
  consumerRepository?: ConsumerStore;
  operations?: OperationTransitions;
  adapter?: BitrixAdapter;
}): Promise<void> {
  const { env, message } = input;
  const consumer = input.consumerRepository ?? new OperationConsumerRepository(env);
  const operations = input.operations ?? createTaskCommanderRepositories(env);
  const stored = await consumer.readExecution(
    message.portalId,
    message.operationId,
    message.launchAttempt,
  );
  if (!stored) return;
  const ownerId = stored.operation.initiator_id;
  const context = createSystemConsumerContext(message.portalId, ownerId);
  async function interruptBeforeStart(reasonMessage: string): Promise<void> {
    await operations.requestOperationInterruption(context, {
      operationId: message.operationId,
      launchAttempt: message.launchAttempt,
      correlationId: `TC-${crypto.randomUUID()}`,
      reasonCode: 'INTERRUPTED',
      reasonMessage,
    });
    await operations.finalizeOperation(context, {
      operationId: message.operationId,
      launchAttempt: message.launchAttempt,
      correlationId: `TC-${crypto.randomUUID()}`,
    });
  }
  if (!stored.operation.idempotency_key.startsWith('confirmation:')) {
    await interruptBeforeStart('План операции недоступен.');
    return;
  }
  if (stored.plan.payloadVersion !== 1) {
    await interruptBeforeStart('Версия плана операции не поддерживается.');
    return;
  }
  const token = stored.operation.idempotency_key.slice('confirmation:'.length);
  let plan: Awaited<ReturnType<typeof decryptExecutionPlan>>;
  try {
    plan = await decryptExecutionPlan({
      keyBase64: env.OPERATION_PLAN_KEY_V1,
      portalId: message.portalId,
      ownerId,
      draftId: stored.operation.preflight_snapshot.draftId,
      draftRevision: stored.operation.preflight_snapshot.draftRevision,
      token,
      ...stored.plan,
    });
  } catch {
    await interruptBeforeStart('План операции повреждён или не может быть расшифрован.');
    return;
  }
  const adapter =
    input.adapter ??
    createBitrixAdapter(env, { currentUserId: ownerId, portalId: message.portalId });
  const intentByTask = new Map(plan.retryIntents?.map((intent) => [intent.taskId, intent]) ?? []);
  const restoreByTask = new Map(plan.restoreIntents?.map((intent) => [intent.taskId, intent]) ?? []);
  const requiredFieldsForTask = (taskId: string) =>
    restoreByTask.get(taskId)?.fieldIds ?? (intentByTask.has(taskId)
      ? Object.keys(intentByTask.get(taskId)?.targetValues ?? {})
      : plan.changes.map((change) => change.fieldId));
  const requiredFields = [...new Set(plan.selectedTaskIds.flatMap(requiredFieldsForTask))];
  const capabilities = await adapter.tasks.getFieldCapabilities();
  if (!capabilities.ok) {
    if (retryable(capabilities.failure))
      throw new RetryableOperationError('Field catalog temporarily unavailable.');
    await interruptBeforeStart('Каталог полей недоступен для операции.');
    return;
  }
  const userFieldIds = new Set(
    capabilities.value.filter((field) => field.kind === 'user').map((field) => field.id),
  );
  const accessVersion = plan.preflight.actorAccessVersion;
  const actor = await adapter.users.getCurrent();
  if (!actor.ok) {
    if (retryable(actor.failure))
      throw new RetryableOperationError('Actor temporarily unavailable.');
    await interruptBeforeStart('Доступ инициатора изменился.');
    return;
  }
  if (
    actor.value.id !== ownerId ||
    !actor.value.isActive ||
    !accessIsCurrent(stored, accessVersion, requiredFields) ||
    (plan.restoreIntents != null && accessVersion !== null &&
      !stored.access?.permissions.includes('restore_operations')) ||
    (accessVersion === null && !actor.value.isAdmin)
  ) {
    await interruptBeforeStart('Доступ инициатора изменился.');
    return;
  }
  const started = await operations.startOperation(context, {
    operationId: message.operationId,
    launchAttempt: message.launchAttempt,
    correlationId: `TC-${crypto.randomUUID()}`,
  });
  if (started.operation.status !== 'running') return;

  const leaseId = crypto.randomUUID();
  if (
    !(await consumer.acquireExecutionLease(
      message.portalId,
      message.operationId,
      message.launchAttempt,
      leaseId,
    ))
  )
    return;
  let activeClaim: { taskId: string; claimId: string } | null = null;
  let leaseAlive = true;
  let abandonedLease = false;
  let progressDeadlineAt = Date.now() + 300_000;
  let heartbeatPending: Promise<void> | null = null;
  function heartbeat() {
    if (heartbeatPending) return;
    if (Date.now() >= progressDeadlineAt) {
      abandonedLease = true;
      leaseAlive = false;
      clearInterval(heartbeatTimer);
      return;
    }
    heartbeatPending = consumer
      .renewExecutionLease({
        portalId: message.portalId,
        operationId: message.operationId,
        launchAttempt: message.launchAttempt,
        leaseId,
        taskId: activeClaim?.taskId ?? null,
        claimId: activeClaim?.claimId ?? null,
      })
      .then((renewed) => {
        if (!renewed) {
          abandonedLease = true;
          leaseAlive = false;
          clearInterval(heartbeatTimer);
        }
      })
      .catch(() => {
        abandonedLease = true;
        leaseAlive = false;
        clearInterval(heartbeatTimer);
      })
      .finally(() => {
        heartbeatPending = null;
      });
  }
  function assertLease() {
    if (Date.now() >= progressDeadlineAt) {
      abandonedLease = true;
      leaseAlive = false;
      clearInterval(heartbeatTimer);
    }
    if (!leaseAlive) throw new RetryableOperationError('Operation execution lease lost.');
  }
  async function settleActiveClaim(): Promise<void> {
    // A terminal claim RPC can commit before its HTTP response. Stop claim-specific
    // renewals before it starts, and drain a renewal already in flight.
    activeClaim = null;
    if (heartbeatPending) await heartbeatPending;
    assertLease();
  }
  const heartbeatTimer = setInterval(heartbeat, 30_000);

  try {
    async function pace(): Promise<void> {
      assertLease();
      const delay = await consumer.reserveRateSlot(
        message.portalId,
        message.operationId,
        message.launchAttempt,
      );
      if (delay === null) throw new RetryableOperationError('Operation is no longer running.');
      if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
      assertLease();
    }

    async function finalize(): Promise<void> {
      assertLease();
      await operations.finalizeOperation(context, {
        operationId: message.operationId,
        launchAttempt: message.launchAttempt,
        correlationId: `TC-${crypto.randomUUID()}`,
      });
    }

    async function record(
      entry: PreflightTaskEntry,
      claim: TaskClaim,
      outcome: 'success' | 'partially_applied' | 'error' | 'unconfirmed' | 'conflict' | 'restored' | 'restore_error',
      snapshot: TaskChangeSnapshot | null,
      reasonCode: string | null,
      afterVersion?: string,
    ): Promise<void> {
      assertLease();
      const appliedFieldIds =
        outcome === 'success' || outcome === 'partially_applied' || outcome === 'restored'
          ? claim.applied_field_ids : [];
      await settleActiveClaim();
      await consumer.record({
        portalId: message.portalId,
        operationId: message.operationId,
        launchAttempt: message.launchAttempt,
        taskId: entry.taskId,
        claimId: claim.claim_id,
        title: snapshot?.title ?? null,
        taskUrl: snapshot?.taskUrl ?? null,
        outcome,
        requestedFieldIds: requiredFieldsForTask(entry.taskId),
        appliedFieldIds,
        failedFieldIds:
          outcome === 'success' || outcome === 'restored'
            ? []
            : outcome === 'partially_applied'
              ? entry.changedFieldIds.filter(
                  (fieldId) => !claim.applied_field_ids.includes(fieldId),
                )
              : entry.changedFieldIds,
        reasonCode,
        reasonMessage: reasonCode
          ? 'Задача не была изменена или результат изменения не подтверждён.'
          : null,
        correlationId: `TC-${crypto.randomUUID()}`,
        canRetry: outcome === 'error' || outcome === 'restore_error' ||
          outcome === 'conflict' || outcome === 'partially_applied',
        ...(afterVersion ? { afterVersion } : {}),
      });
      progressDeadlineAt = Date.now() + 300_000;
    }

    let processedThisDelivery = 0;
    for (const entry of plan.preflight.entries) {
      if (entry.disposition !== 'eligible') continue;
      const taskRequiredFields = requiredFieldsForTask(entry.taskId);
      const fields = readFieldIds(taskRequiredFields.map((fieldId) => ({ fieldId })));
      if (processedThisDelivery >= 100) {
        const latest = await consumer.readExecution(
          message.portalId,
          message.operationId,
          message.launchAttempt,
        );
        if (!latest || latest.operation.status !== 'running') return;
        if (latest.operation.cancel_requested_at || latest.operation.interruption_requested_at) {
          await finalize();
          return;
        }
        assertLease();
        clearInterval(heartbeatTimer);
        await consumer.releaseExecutionLease(
          message.portalId,
          message.operationId,
          message.launchAttempt,
          leaseId,
        );
        await getRequiredQueueBinding(env.OPERATIONS_QUEUE).send(message);
        return;
      }
      const currentExecution = await consumer.readExecution(
        message.portalId,
        message.operationId,
        message.launchAttempt,
      );
      if (!currentExecution || currentExecution.operation.status !== 'running') return;
      assertLease();
      if (
        currentExecution.operation.cancel_requested_at ||
        currentExecution.operation.interruption_requested_at
      ) {
        await finalize();
        return;
      }
      await pace();
      const currentActor = await adapter.users.getCurrent();
      assertLease();
      if (!currentActor.ok && retryable(currentActor.failure)) {
        throw new RetryableOperationError('Actor revalidation temporarily unavailable.');
      }
      if (
        !accessIsCurrent(currentExecution, accessVersion, taskRequiredFields) ||
        (restoreByTask.size > 0 && accessVersion !== null &&
          !currentExecution.access?.permissions.includes('restore_operations')) ||
        !currentActor.ok ||
        !currentActor.value.isActive ||
        currentActor.value.id !== ownerId ||
        (accessVersion === null && !currentActor.value.isAdmin)
      ) {
        await operations.requestOperationInterruption(context, {
          operationId: message.operationId,
          launchAttempt: message.launchAttempt,
          correlationId: `TC-${crypto.randomUUID()}`,
          reasonCode: 'INTERRUPTED',
          reasonMessage: 'Доступ инициатора изменился.',
        });
        await finalize();
        return;
      }
      const claimResponse = await consumer.claim(
        message.portalId,
        message.operationId,
        message.launchAttempt,
        entry.taskId,
      );
      assertLease();
      if (claimResponse.disposition === 'stale') {
        const latest = await consumer.readExecution(
          message.portalId,
          message.operationId,
          message.launchAttempt,
        );
        if (latest?.operation.cancel_requested_at || latest?.operation.interruption_requested_at) {
          await finalize();
        }
        return;
      }
      if (claimResponse.disposition === 'done') {
        progressDeadlineAt = Date.now() + 300_000;
        continue;
      }
      if (claimResponse.disposition === 'busy' || !claimResponse.claim) {
        throw new RetryableOperationError('Task is claimed by another consumer.');
      }
      const claim = claimResponse.claim;
      activeClaim = { taskId: entry.taskId, claimId: claim.claim_id };
      processedThisDelivery += 1;
      await pace();
      let read = await adapter.tasks.readForChange({ taskId: entry.taskId, fieldIds: fields });
      assertLease();
      if (!read.ok) {
        if (retryable(read.failure)) {
          if (claim.phase === 'prepared') {
            await settleActiveClaim();
            await consumer.release(
              message.portalId,
              message.operationId,
              entry.taskId,
              claim.claim_id,
            );
          }
          throw new RetryableOperationError('Task reread temporarily unavailable.');
        }
        await record(
          entry,
          claim,
          claim.phase === 'prepared'
            ? (restoreByTask.has(entry.taskId) ? 'restore_error' : 'error')
            : 'unconfirmed',
          null,
          claim.phase === 'prepared' ? 'TASK_UNAVAILABLE' : 'UPSTREAM_OUTCOME_UNKNOWN',
        );
        continue;
      }
      const snapshot = read.value;
      const restoreIntent = restoreByTask.get(entry.taskId);
      if (claimResponse.disposition === 'reconcile') {
        const confirmed =
          claim.phase === 'applied' &&
          claim.after_mutation_version !== null &&
          snapshot.mutationVersion === claim.after_mutation_version
            ? confirmedOutcome(snapshot, entry, claim)
            : null;
        if (confirmed) {
          await record(
            entry,
            claim,
            restoreIntent && confirmed === 'success' ? 'restored' : confirmed,
            snapshot,
            confirmed === 'partially_applied' ? 'PARTIALLY_APPLIED' : null,
            `mock:${claim.after_mutation_version}`,
          );
        } else {
          await record(entry, claim, 'unconfirmed', snapshot, 'UPSTREAM_OUTCOME_UNKNOWN');
        }
        continue;
      }
      if (
        snapshot.relevantVersion !== entry.relevantVersion ||
        (restoreIntent && (snapshot.mutationVersion === undefined ||
          `mock:${snapshot.mutationVersion}` !== restoreIntent.afterVersion)) ||
        snapshot.status === 'completed' ||
        snapshot.isTemplate ||
        snapshot.isRecurrenceRule ||
        !taskRequiredFields.every((fieldId) => snapshot.editableFieldIds.includes(fieldId)) ||
        snapshot.mutationVersion === undefined
      ) {
        await record(entry, claim, 'conflict', snapshot, 'TASK_STATE_CHANGED');
        continue;
      }
      const targetUserIds = [
        ...new Set(
          entry.changedFieldIds.flatMap((fieldId) => {
            if (!userFieldIds.has(fieldId)) return [];
            const value = entry.targetValues?.[fieldId];
            return typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
          }),
        ),
      ];
      if (targetUserIds.length > 0) {
        await pace();
        const users = await adapter.users.getAccessStatuses(targetUserIds);
        assertLease();
        if (!users.ok) {
          if (retryable(users.failure)) {
            await settleActiveClaim();
            await consumer.release(
              message.portalId,
              message.operationId,
              entry.taskId,
              claim.claim_id,
            );
            throw new RetryableOperationError('Target user revalidation temporarily unavailable.');
          }
          await record(entry, claim, restoreIntent ? 'restore_error' : 'error', snapshot, 'RELATED_USER_UNAVAILABLE');
          continue;
        }
        if (
          users.value.length !== targetUserIds.length ||
          users.value.some((status) => status.state !== 'active' || !status.user.isActive)
        ) {
          await record(entry, claim, 'conflict', snapshot, 'RELATED_USER_UNAVAILABLE');
          continue;
        }
      }
      const targetProjectId = entry.targetValues?.group_id;
      if (typeof targetProjectId === 'string') {
        await pace();
        const projects = await adapter.organization.getProjectAccessStatuses([targetProjectId]);
        assertLease();
        if (!projects.ok) {
          if (retryable(projects.failure)) {
            await settleActiveClaim();
            await consumer.release(
              message.portalId,
              message.operationId,
              entry.taskId,
              claim.claim_id,
            );
            throw new RetryableOperationError(
              'Target project revalidation temporarily unavailable.',
            );
          }
          await record(entry, claim, restoreIntent ? 'restore_error' : 'error', snapshot, 'RELATED_PROJECT_UNAVAILABLE');
          continue;
        }
        if (projects.value.length !== 1 || projects.value[0]?.state !== 'available') {
          await record(entry, claim, 'conflict', snapshot, 'RELATED_PROJECT_UNAVAILABLE');
          continue;
        }
      }
      const beforeVersion = `mock:${snapshot.mutationVersion}`;
      const protectedResult = await encryptPreviousValues({
        keyBase64: env.OPERATION_PLAN_KEY_V1,
        portalId: message.portalId,
        ownerId,
        operationId: message.operationId,
        taskId: entry.taskId,
        beforeVersion,
        values: Object.fromEntries(
          entry.changedFieldIds.map((fieldId) => [fieldId,
            Object.hasOwn(snapshot.values, fieldId) ? snapshot.values[fieldId] : null]),
        ),
      });
      assertLease();
      await pace();
      if (
        !(await consumer.markWriting({
          portalId: message.portalId,
          operationId: message.operationId,
          launchAttempt: message.launchAttempt,
          taskId: entry.taskId,
          claimId: claim.claim_id,
          beforeVersion,
          beforeMutationVersion: snapshot.mutationVersion,
          actorAccessVersion: accessVersion,
          requiredFieldIds: taskRequiredFields,
          protectedResult,
        }))
      ) {
        throw new RetryableOperationError('Task claim expired before write.');
      }
      assertLease();
      const targetValues = Object.fromEntries(
        entry.changedFieldIds.map((fieldId) => [fieldId, entry.targetValues?.[fieldId]]),
      );
      const applied = await adapter.tasks.applyChange({
        taskId: entry.taskId,
        expectedRelevantVersion: snapshot.relevantVersion,
        relevantFieldIds: fields,
        targetValues,
        executionFence: {
          portalId: message.portalId,
          operationId: message.operationId,
          launchAttempt: message.launchAttempt,
          claimId: claim.claim_id,
          expectedMutationVersion: snapshot.mutationVersion,
        },
      });
      assertLease();
      const afterClaim = await consumer.readClaim(
        message.portalId,
        message.operationId,
        entry.taskId,
      );
      if (!afterClaim || afterClaim.claim_id !== claim.claim_id) {
        throw new RetryableOperationError('Task claim changed during write.');
      }
      if (
        !applied.ok &&
        applied.failure.kind === 'rate_limited' &&
        afterClaim.phase === 'writing'
      ) {
        await settleActiveClaim();
        if (
          await consumer.releaseRateLimited(
            message.portalId,
            message.operationId,
            entry.taskId,
            claim.claim_id,
          )
        ) {
          throw new RetryableOperationError('Task write rate limited.');
        }
      }
      if (afterClaim.phase === 'applied' && afterClaim.after_mutation_version !== null) {
        await pace();
        read = await adapter.tasks.readForChange({ taskId: entry.taskId, fieldIds: fields });
        assertLease();
        if (!read.ok && retryable(read.failure)) {
          throw new RetryableOperationError('Post-write reread temporarily unavailable.');
        }
        const confirmed =
          read.ok && read.value.mutationVersion === afterClaim.after_mutation_version
            ? confirmedOutcome(read.value, entry, afterClaim)
            : null;
        if (confirmed && read.ok) {
          await record(
            entry,
            afterClaim,
            restoreIntent && confirmed === 'success' ? 'restored' : confirmed,
            read.value,
            confirmed === 'partially_applied' ? 'PARTIALLY_APPLIED' : null,
            `mock:${afterClaim.after_mutation_version}`,
          );
        } else {
          await record(
            entry,
            afterClaim,
            'unconfirmed',
            read.ok ? read.value : null,
            'UPSTREAM_OUTCOME_UNKNOWN',
          );
        }
        continue;
      }
      if (applied.ok && applied.value.kind === 'conflict') {
        await record(entry, afterClaim, 'conflict', snapshot, 'TASK_STATE_CHANGED');
      } else if (
        !applied.ok &&
        (applied.failure.kind === 'not_authenticated' ||
          applied.failure.kind === 'permission_denied' ||
          applied.failure.kind === 'permanent_failure' ||
          applied.failure.kind === 'not_found_or_forbidden' ||
          applied.failure.kind === 'unsupported_capability')
      ) {
        await record(entry, afterClaim, restoreIntent ? 'restore_error' : 'error', snapshot, 'TASK_WRITE_REJECTED');
      } else {
        await record(entry, afterClaim, 'unconfirmed', snapshot, 'UPSTREAM_OUTCOME_UNKNOWN');
      }
    }
    await finalize();
  } finally {
    clearInterval(heartbeatTimer);
    if (!abandonedLease) {
      await consumer.releaseExecutionLease(
        message.portalId,
        message.operationId,
        message.launchAttempt,
        leaseId,
      );
    }
  }
}
