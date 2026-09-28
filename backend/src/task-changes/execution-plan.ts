import type { BulkOperationDraft, PreflightPreview } from '@task-commander/contracts';

import { hasValidOperationPlanKey, RuntimeConfigurationError } from '../runtime/configuration';

function encodeBase64(bytes: Uint8Array): string {
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 8192) {
    encoded += String.fromCharCode(...bytes.subarray(index, index + 8192));
  }
  return btoa(encoded);
}

export async function encryptExecutionPlan(input: {
  keyBase64: string | undefined;
  portalId: string;
  ownerId: string;
  token: string;
  draft: BulkOperationDraft;
  preview: PreflightPreview;
}): Promise<{ ciphertext: string; nonce: string; keyVersion: string }> {
  let keyBytes: Uint8Array;
  if (!hasValidOperationPlanKey(input.keyBase64)) {
    throw new RuntimeConfigurationError('Operation plan key is invalid.');
  }
  try {
    keyBytes = Uint8Array.from(atob(input.keyBase64 ?? ''), (character) => character.charCodeAt(0));
  } catch {
    throw new RuntimeConfigurationError('Operation plan key is invalid.');
  }
  if (keyBytes.length !== 32) {
    throw new RuntimeConfigurationError('Operation plan key must be 32 bytes.');
  }
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const associatedData = new TextEncoder().encode(
    `task-commander:operation-plan:v1:${input.portalId}:${input.ownerId}:${input.draft.id}:${input.draft.revision}:${input.token}`,
  );
  const plaintext = new TextEncoder().encode(
    JSON.stringify({
      draftId: input.draft.id,
      draftRevision: input.draft.revision,
      selectedTaskIds: input.draft.selectedTaskIds,
      filters: input.draft.filters,
      sort: input.draft.sort,
      changes: input.draft.changes,
      preflight: input.preview,
    }),
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: associatedData },
      key,
      plaintext,
    ),
  );
  return { ciphertext: encodeBase64(ciphertext), nonce: encodeBase64(nonce), keyVersion: 'v1' };
}
