import {
  getRequiredR2Binding,
  RuntimeConfigurationError,
} from './runtime/configuration';
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
  env: Pick<Env, 'REPORTS_BUCKET'>,
): Promise<void> {
  for (const message of batch.messages) {
    if (!isRuntimeProbeMessage(message.body)) {
      console.error(
        JSON.stringify({
          event: 'runtime_probe_rejected',
          messageId: message.id,
          schemaVersion: getSafeSchemaVersion(message.body),
        }),
      );
      message.retry();
      continue;
    }

    try {
      await verifyRuntimeProbeArtifact(getRequiredR2Binding(env.REPORTS_BUCKET), message.body);
      message.ack();
      console.info(JSON.stringify({ event: 'runtime_probe_consumed', messageId: message.body.messageId }));
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

export default {
  queue(batch, env, context) {
    context.waitUntil(consumeRuntimeProbeBatch(batch, env));
  },
} satisfies ExportedHandler<Env>;
