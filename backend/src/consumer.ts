import { accessPermissionCatalog } from '@task-commander/contracts';

import { accessCommandQueueMessageSchema } from './contracts/access-command-queue';
import { operationQueueMessageSchema } from './contracts/operation-queue';
import { createAccessManagementRepository, type AccessManagementRepository } from './data';
import {
  getRequiredR2Binding,
  RuntimeConfigurationError,
  type RuntimeEnvironment,
} from './runtime/configuration';
import { createBitrixAdapter } from './integrations/bitrix/factory';
import type { BitrixFailure } from './integrations/bitrix/contract';
import { isRuntimeProbeMessage, verifyRuntimeProbeArtifact } from './runtime/probe';

function getSafeSchemaVersion(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const schemaVersion = (value as Record<string, unknown>).schemaVersion;
  return typeof schemaVersion === 'number' ? schemaVersion : undefined;
}

export async function consumeRuntimeProbeBatch(
  batch: MessageBatch<unknown>,
  env: Pick<RuntimeEnvironment, 'REPORTS_BUCKET'>,
): Promise<void> {
  for (const message of batch.messages) {
    const operation = operationQueueMessageSchema.safeParse(message.body);
    if (operation.success) {
      // Task execution starts in 022. Never acknowledge a valid operation without a worker.
      // Finite Queue retries lead to DLQ; the durable outbox republishes a still-launching attempt.
      message.retry();
      continue;
    }
    if (!isRuntimeProbeMessage(message.body)) {
      console.error(
        JSON.stringify({
          event: 'runtime_probe_rejected',
          messageId: message.id,
          schemaVersion: getSafeSchemaVersion(message.body),
        }),
      );
      message.ack();
      continue;
    }

    try {
      await verifyRuntimeProbeArtifact(getRequiredR2Binding(env.REPORTS_BUCKET), message.body);
      message.ack();
      console.info(
        JSON.stringify({ event: 'runtime_probe_consumed', messageId: message.body.messageId }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event:
            error instanceof RuntimeConfigurationError
              ? 'runtime_probe_configuration_error'
              : 'runtime_probe_failed',
          messageId: message.id,
        }),
      );
      message.retry();
    }
  }
}

function commandStateVersion(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) return null;
  const command = (value as Record<string, unknown>).command;
  if (typeof command !== 'object' || command === null) return null;
  const version = (command as Record<string, unknown>).state_version;
  return typeof version === 'number' && Number.isSafeInteger(version) ? version : null;
}

function isRetryableBitrixFailure(failure: BitrixFailure): boolean {
  return failure.kind === 'rate_limited' || failure.kind === 'temporary_failure';
}

async function executeAccessCommand(
  repository: AccessManagementRepository,
  env: RuntimeEnvironment,
  portalId: string,
  commandId: string,
): Promise<void> {
  let stored = await repository.readCommand({ portalId, commandId });
  if (!stored.command) return;
  if (['succeeded', 'partially_succeeded', 'failed', 'no_change'].includes(stored.command.state)) {
    return;
  }
  if (stored.command.state === 'accepted') {
    await repository.claimCommand(portalId, commandId, stored.command.state_version);
    stored = await repository.readCommand({ portalId, commandId });
  }
  if (!stored.command || !['validating', 'in_progress'].includes(stored.command.state)) return;

  const preflight = await repository.readPreflight({
    portalId,
    preflightId: stored.command.preflight_id,
  });
  if (
    !preflight.preflight ||
    preflight.preflight.permission_matrix_version !== accessPermissionCatalog.version
  ) {
    await repository.failCommand(
      portalId,
      commandId,
      stored.command.state_version,
      preflight.preflight ? 'PERMISSION_CATALOG_CHANGED' : 'INTERNAL_ERROR',
    );
    return;
  }

  const adapter = createBitrixAdapter(env, { currentUserId: stored.command.actor_user_id });
  for (const target of stored.targets.filter((candidate) => candidate.state === 'ready')) {
    const actor = await adapter.users.getCurrent();
    const [leadership, targetProfile] = await Promise.all([
      actor.ok && actor.value.isAdmin
        ? Promise.resolve({ ok: true as const, value: [] })
        : adapter.organization.getLeadership(stored.command.actor_user_id),
      adapter.users.getEmployeeProfile(target.target_user_id),
    ]);
    if (!actor.ok || !leadership.ok) {
      if (
        (!actor.ok && isRetryableBitrixFailure(actor.failure)) ||
        (!leadership.ok && isRetryableBitrixFailure(leadership.failure))
      ) {
        throw new Error('Access actor revalidation is temporarily unavailable.');
      }
      const current = await repository.readCommand({ portalId, commandId });
      if (current.command) {
        await repository.failCommand(
          portalId,
          commandId,
          current.command.state_version,
          'ACTOR_ACCESS_CHANGED',
        );
      }
      return;
    }
    if (!targetProfile.ok && isRetryableBitrixFailure(targetProfile.failure)) {
      throw new Error('Access target revalidation is temporarily unavailable.');
    }
    let targetIsManager = false;
    if (targetProfile.ok && target.desired_permissions.includes('manage_access')) {
      const targetLeadership = await adapter.organization.getLeadership(target.target_user_id);
      if (!targetLeadership.ok) {
        if (isRetryableBitrixFailure(targetLeadership.failure)) {
          throw new Error('Access target leadership revalidation is temporarily unavailable.');
        }
      } else {
        targetIsManager = targetLeadership.value.length > 0;
      }
    }
    const current = await repository.readCommand({ portalId, commandId });
    if (!current.command) return;
    const result = await repository.applyCommandTarget({
      portalId,
      commandId,
      expectedStateVersion: current.command.state_version,
      targetUserId: target.target_user_id,
      actorIsActive: actor.value.isActive,
      actorIsPortalAdmin: actor.value.isAdmin,
      actorIsManager: actor.value.isAdmin || leadership.value.length > 0,
      targetIsActive: targetProfile.ok ? targetProfile.value.isActive : null,
      targetIsManager,
      targetIsPortalAdmin: targetProfile.ok && targetProfile.value.isAdmin,
    });
    if (commandStateVersion(result) === null) {
      throw new Error('Access target transition returned an invalid state.');
    }
  }
  stored = await repository.readCommand({ portalId, commandId });
  if (stored.command && ['validating', 'in_progress'].includes(stored.command.state)) {
    await repository.finalizeCommand(portalId, commandId, stored.command.state_version);
  }
}

export async function consumeQueueBatch(
  batch: MessageBatch<unknown>,
  env: RuntimeEnvironment,
  createRepository: (
    env: RuntimeEnvironment,
  ) => AccessManagementRepository = createAccessManagementRepository,
): Promise<void> {
  let repository: AccessManagementRepository | undefined;
  for (const message of batch.messages) {
    const accessMessage = accessCommandQueueMessageSchema.safeParse(message.body);
    if (!accessMessage.success) {
      console.error(
        JSON.stringify({
          event: 'access_command_rejected',
          messageId: message.id,
          schemaVersion: getSafeSchemaVersion(message.body),
        }),
      );
      message.ack();
      continue;
    }
    try {
      repository ??= createRepository(env);
      await executeAccessCommand(
        repository,
        env,
        accessMessage.data.portalId,
        accessMessage.data.commandId,
      );
      message.ack();
    } catch {
      console.error(
        JSON.stringify({
          event: 'access_command_failed',
          messageId: message.id,
          commandId: accessMessage.data.commandId,
        }),
      );
      if (message.attempts >= 5 && repository) {
        const stored = await repository.readCommand({
          portalId: accessMessage.data.portalId,
          commandId: accessMessage.data.commandId,
        });
        if (
          !stored.command ||
          ['succeeded', 'partially_succeeded', 'failed', 'no_change'].includes(stored.command.state)
        ) {
          message.ack();
        } else if (['validating', 'in_progress'].includes(stored.command.state)) {
          await repository.failCommand(
            accessMessage.data.portalId,
            accessMessage.data.commandId,
            stored.command.state_version,
            'INTERNAL_ERROR',
          );
          message.ack();
        } else {
          message.retry();
        }
      } else {
        message.retry();
      }
    }
  }
}

export default {
  queue(batch, env, context) {
    if (batch.queue === env.ACCESS_COMMANDS_QUEUE_NAME) {
      context.waitUntil(consumeQueueBatch(batch, env));
      return;
    }
    if (batch.queue === env.OPERATIONS_QUEUE_NAME) {
      context.waitUntil(consumeRuntimeProbeBatch(batch, env));
      return;
    }
    for (const message of batch.messages) message.ack();
    console.error(JSON.stringify({ event: 'queue_rejected', queue: batch.queue }));
  },
} satisfies ExportedHandler<ConsumerEnvironment>;
