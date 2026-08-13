import { createAccessCommandQueueMessage } from '../contracts/access-command-queue';
import {
  createAccessManagementRepository,
  type AccessManagementRepository,
} from '../data';
import type { RuntimeEnvironment } from '../runtime/configuration';

function commandQueue(env: RuntimeEnvironment): Queue {
  const queue = env.ACCESS_COMMANDS_QUEUE as Queue | undefined;
  if (!queue || typeof queue.send !== 'function') {
    throw new Error('Access command queue is unavailable.');
  }
  return queue;
}

export async function dispatchAccessCommand(input: {
  repository: AccessManagementRepository;
  env: RuntimeEnvironment;
  portalId: string;
  commandId: string;
}): Promise<void> {
  const dispatch = await input.repository.readCommandDispatch(input.portalId, input.commandId);
  if (!dispatch || dispatch.status !== 'pending') return;
  await commandQueue(input.env).send(
    createAccessCommandQueueMessage({
      portalId: input.portalId,
      commandId: input.commandId,
    }),
  );
  await input.repository.markCommandDispatched(input.portalId, input.commandId);
}

/** Cron recovery for a DB-accepted command whose first Queue send was interrupted. */
export async function dispatchPendingAccessCommands(env: RuntimeEnvironment): Promise<void> {
  const repository = createAccessManagementRepository(env);
  const pending = await repository.listPendingCommandDispatches(100);
  for (const item of pending) {
    try {
      await dispatchAccessCommand({
        repository,
        env,
        portalId: item.portal_id,
        commandId: item.command_id,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'access_command_dispatch_failed',
          commandId: item.command_id,
          errorName: error instanceof Error ? error.name : 'unknown',
        }),
      );
    }
  }
  // Queue retries are finite. Re-enqueue commands whose worker lease made no progress so a
  // transient DB failure on the last delivery cannot strand access changes indefinitely.
  const stale = await repository.listStaleCommands(
    new Date(Date.now() - 15 * 60_000).toISOString(),
    100,
  );
  for (const command of stale) {
    try {
      await commandQueue(env).send(createAccessCommandQueueMessage({
        portalId: command.portal_id,
        commandId: command.id,
      }));
    } catch (error) {
      console.error(JSON.stringify({
        event: 'access_command_stale_recovery_failed',
        commandId: command.id,
        errorName: error instanceof Error ? error.name : 'unknown',
      }));
    }
  }
}
