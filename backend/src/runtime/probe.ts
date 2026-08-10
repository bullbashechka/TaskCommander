export const LOCAL_RUNTIME_EPOCH = 1;
export const RUNTIME_PROBE_KIND = 'runtime.probe';

export interface RuntimeProbeMessage {
  schemaVersion: typeof LOCAL_RUNTIME_EPOCH;
  messageId: string;
  kind: typeof RUNTIME_PROBE_KIND;
  createdAt: string;
  payload: {
    artifactKey: string;
  };
}

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
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== LOCAL_RUNTIME_EPOCH ||
    candidate.kind !== RUNTIME_PROBE_KIND ||
    typeof candidate.messageId !== 'string' ||
    candidate.messageId.length === 0 ||
    typeof candidate.createdAt !== 'string' ||
    candidate.createdAt.length === 0 ||
    typeof candidate.payload !== 'object' ||
    candidate.payload === null
  ) {
    return false;
  }

  const payload = candidate.payload as Record<string, unknown>;
  return (
    typeof payload.artifactKey === 'string' &&
    payload.artifactKey.startsWith(`v${LOCAL_RUNTIME_EPOCH}/runtime-probe/json/`)
  );
}

export async function verifyRuntimeProbeArtifact(
  bucket: R2Bucket,
  probe: RuntimeProbeMessage,
): Promise<void> {
  const artifact = JSON.stringify({
    kind: probe.kind,
    messageId: probe.messageId,
  });
  await bucket.put(probe.payload.artifactKey, artifact);

  const storedArtifact = await bucket.get(probe.payload.artifactKey);
  if (storedArtifact === null) {
    throw new Error('Runtime probe artifact is unavailable.');
  }

  if ((await storedArtifact.text()) !== artifact) {
    throw new Error('Runtime probe artifact is invalid.');
  }

  await bucket.delete(probe.payload.artifactKey);
}
