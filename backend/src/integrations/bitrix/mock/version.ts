import type { TaskChangeSnapshot } from '../contract';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return [...value]
      .map(canonicalize)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, canonicalize(nestedValue)]),
    );
  }

  return value;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export async function createRelevantVersion(
  snapshot: Omit<TaskChangeSnapshot, 'relevantVersion'>,
): Promise<string> {
  const payload = JSON.stringify(
    canonicalize({
      status: snapshot.status,
      values: snapshot.values,
      editableFieldIds: snapshot.editableFieldIds,
      isTemplate: snapshot.isTemplate,
      isRecurrenceRule: snapshot.isRecurrenceRule,
      deadlineManagedBySubtasks: snapshot.deadlineManagedBySubtasks,
    }),
  );
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return toBase64Url(new Uint8Array(digest));
}
