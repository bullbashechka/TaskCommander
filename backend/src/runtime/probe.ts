import { z } from 'zod';

export const LOCAL_RUNTIME_EPOCH = 1;
export const RUNTIME_PROBE_KIND = 'runtime.probe';

export const runtimeProbeMessageSchema = z
  .object({
    schemaVersion: z.literal(LOCAL_RUNTIME_EPOCH),
    messageId: z.string().trim().min(1).max(128),
    kind: z.literal(RUNTIME_PROBE_KIND),
    createdAt: z.string().datetime({ offset: true }),
    payload: z
      .object({
        artifactKey: z
          .string()
          .regex(new RegExp(`^v${LOCAL_RUNTIME_EPOCH}/runtime-probe/json/.+\\.json$`)),
      })
      .strict(),
  })
  .strict();

export type RuntimeProbeMessage = z.infer<typeof runtimeProbeMessageSchema>;

export function createRuntimeProbe(): RuntimeProbeMessage {
  const messageId = crypto.randomUUID();

  return {
    schemaVersion: LOCAL_RUNTIME_EPOCH,
    messageId,
    kind: RUNTIME_PROBE_KIND,
    createdAt: new Date().toISOString(),
    payload: {
      artifactKey: `v${LOCAL_RUNTIME_EPOCH}/runtime-probe/json/${messageId}.json`,
    },
  };
}

export function isRuntimeProbeMessage(value: unknown): value is RuntimeProbeMessage {
  return runtimeProbeMessageSchema.safeParse(value).success;
}

export async function verifyRuntimeProbeArtifact(
  bucket: R2Bucket,
  probe: RuntimeProbeMessage,
): Promise<void> {
  const artifact = JSON.stringify({
    kind: probe.kind,
    messageId: probe.messageId,
  });
  let primaryError: unknown;
  let cleanupError: unknown;
  try {
    await bucket.put(probe.payload.artifactKey, artifact);
    const storedArtifact = await bucket.get(probe.payload.artifactKey);
    if (storedArtifact === null) {
      throw new Error('Runtime probe artifact is unavailable.');
    }
    if ((await storedArtifact.text()) !== artifact) {
      throw new Error('Runtime probe artifact is invalid.');
    }
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      await bucket.delete(probe.payload.artifactKey);
    } catch (error) {
      cleanupError = error;
    }
  }
  if (primaryError !== undefined) {
    if (cleanupError !== undefined) {
      console.error(JSON.stringify({ event: 'runtime_probe_cleanup_failed' }));
    }
    throw primaryError;
  }
  if (cleanupError !== undefined) {
    throw cleanupError;
  }
}
