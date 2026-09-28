import { createOperationQueueMessage } from '../contracts/operation-queue';
import { createTaskCommanderRepositories, type TaskCommanderRepositories } from '../data';
import { getRequiredQueueBinding, type RuntimeEnvironment } from '../runtime/configuration';
import { OperationConsumerRepository } from './operation-consumer-repository';

type DispatchRepository = Pick<
  TaskCommanderRepositories,
  'claimOperationLaunchDispatch' | 'completeOperationLaunchDispatch'
>;

export async function dispatchOperationLaunch(input: {
  env: RuntimeEnvironment;
  repository: DispatchRepository;
  portalId: string;
  operationId: string;
  correlationId: string;
}): Promise<void> {
  const dispatch = await input.repository.claimOperationLaunchDispatch(
    input.portalId,
    input.operationId,
  );
  if (!dispatch || !dispatch.claim_id) return;
  try {
    await getRequiredQueueBinding(input.env.OPERATIONS_QUEUE).send(
      createOperationQueueMessage({
        portalId: dispatch.portal_id,
        operationId: dispatch.operation_id,
        launchAttempt: dispatch.launch_attempt,
        messageId: dispatch.message_id,
        createdAt: dispatch.created_at,
      }),
    );
  } catch (error) {
    // A rejected send can be ambiguous. The SQL transition only fails an operation still launching;
    // a consumer that already claimed it remains running. Recovery reuses the stored message ID.
    await input.repository.completeOperationLaunchDispatch({
      portalId: input.portalId,
      operationId: input.operationId,
      launchAttempt: dispatch.launch_attempt,
      messageId: dispatch.message_id,
      claimId: dispatch.claim_id,
      sent: false,
      correlationId: input.correlationId,
    });
    throw error;
  }
  // If marking the send fails, leave the outbox pending. Re-sending its stable envelope is safe.
  await input.repository.completeOperationLaunchDispatch({
    portalId: input.portalId,
    operationId: input.operationId,
    launchAttempt: dispatch.launch_attempt,
    messageId: dispatch.message_id,
    claimId: dispatch.claim_id,
    sent: true,
    correlationId: input.correlationId,
  });
}

export async function dispatchPendingOperationLaunches(
  env: RuntimeEnvironment,
  repository: TaskCommanderRepositories = createTaskCommanderRepositories(env),
): Promise<void> {
  const pending = await repository.listRecoverableOperationDispatches(100);
  for (const dispatch of pending) {
    try {
      await dispatchOperationLaunch({
        env,
        repository,
        portalId: dispatch.portal_id,
        operationId: dispatch.operation_id,
        correlationId: `TC-${crypto.randomUUID()}`,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'operation_launch_dispatch_failed',
          operationId: dispatch.operation_id,
          errorName: error instanceof Error ? error.name : 'unknown',
        }),
      );
    }
  }
}

export async function redriveStalledOperations(
  env: RuntimeEnvironment,
  repository: Pick<
    OperationConsumerRepository,
    'claimStalledExecutions'
  > = new OperationConsumerRepository(env),
): Promise<void> {
  const stalled = await repository.claimStalledExecutions(100);
  for (const dispatch of stalled) {
    try {
      await getRequiredQueueBinding(env.OPERATIONS_QUEUE).send(
        createOperationQueueMessage({
          portalId: dispatch.portal_id,
          operationId: dispatch.operation_id,
          launchAttempt: dispatch.launch_attempt,
          messageId: dispatch.message_id,
          createdAt: dispatch.created_at,
        }),
      );
    } catch {
      console.error(
        JSON.stringify({
          event: 'operation_execution_redrive_failed',
          operationId: dispatch.operation_id,
        }),
      );
    }
  }
}
