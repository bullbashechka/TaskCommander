import {
  bulkOperationDraftSchema,
  preflightPreviewSchema,
  type BulkOperationDraft,
  type PreflightPreview,
} from '@task-commander/contracts';
import { z } from 'zod';

import { hasValidOperationPlanKey, RuntimeConfigurationError } from '../runtime/configuration';

function encodeBase64(bytes: Uint8Array): string {
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 8192) {
    encoded += String.fromCharCode(...bytes.subarray(index, index + 8192));
  }
  return btoa(encoded);
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

const executionPlanSchema = z
  .object({
    draftId: bulkOperationDraftSchema.shape.id,
    draftRevision: bulkOperationDraftSchema.shape.revision,
    selectedTaskIds: bulkOperationDraftSchema.shape.selectedTaskIds,
    filters: bulkOperationDraftSchema.shape.filters,
    sort: bulkOperationDraftSchema.shape.sort,
    changes: bulkOperationDraftSchema.shape.changes,
    retrySourceOperationId: bulkOperationDraftSchema.shape.retrySourceOperationId,
    retrySourceStateVersion: bulkOperationDraftSchema.shape.retrySourceStateVersion,
    retryIntents: bulkOperationDraftSchema.shape.retryIntents,
    preflight: preflightPreviewSchema,
  })
  .strict();

export type ExecutionPlan = z.infer<typeof executionPlanSchema>;

function planAssociatedData(input: {
  portalId: string;
  ownerId: string;
  draftId: string;
  draftRevision: number;
  token: string;
}): Uint8Array {
  return new TextEncoder().encode(
    `task-commander:operation-plan:v1:${input.portalId}:${input.ownerId}:${input.draftId}:${input.draftRevision}:${input.token}`,
  );
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
  const associatedData = planAssociatedData({
    portalId: input.portalId,
    ownerId: input.ownerId,
    draftId: input.draft.id,
    draftRevision: input.draft.revision,
    token: input.token,
  });
  const plaintext = new TextEncoder().encode(
    JSON.stringify({
      draftId: input.draft.id,
      draftRevision: input.draft.revision,
      selectedTaskIds: input.draft.selectedTaskIds,
      filters: input.draft.filters,
      sort: input.draft.sort,
      changes: input.draft.changes,
      retrySourceOperationId: input.draft.retrySourceOperationId,
      retrySourceStateVersion: input.draft.retrySourceStateVersion,
      retryIntents: input.draft.retryIntents,
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

export async function decryptExecutionPlan(input: {
  keyBase64: string | undefined;
  portalId: string;
  ownerId: string;
  draftId: string;
  draftRevision: number;
  token: string;
  ciphertext: string;
  nonce: string;
  keyVersion: string;
}): Promise<ExecutionPlan> {
  if (!hasValidOperationPlanKey(input.keyBase64) || input.keyVersion !== 'v1') {
    throw new RuntimeConfigurationError('Operation plan key is invalid.');
  }
  const nonce = decodeBase64(input.nonce);
  if (nonce.byteLength !== 12) throw new Error('Invalid operation plan nonce.');
  const key = await crypto.subtle.importKey(
    'raw',
    decodeBase64(input.keyBase64 ?? ''),
    'AES-GCM',
    false,
    ['decrypt'],
  );
  const decrypted = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: nonce,
      additionalData: planAssociatedData(input),
    },
    key,
    decodeBase64(input.ciphertext),
  );
  const plan = executionPlanSchema.parse(JSON.parse(new TextDecoder().decode(decrypted)));
  if (
    plan.draftId !== input.draftId ||
    plan.draftRevision !== input.draftRevision ||
    plan.preflight.draftId !== input.draftId ||
    plan.preflight.draftRevision !== input.draftRevision ||
    plan.selectedTaskIds.length !== plan.preflight.entries.length ||
    plan.selectedTaskIds.some(
      (taskId, index) => plan.preflight.entries[index]?.taskId !== taskId,
    ) ||
    (plan.retryIntents != null &&
      (plan.retrySourceOperationId == null ||
        plan.retrySourceStateVersion == null ||
        plan.retryIntents.length !== plan.selectedTaskIds.length ||
        plan.retryIntents.some((intent, index) => intent.taskId !== plan.selectedTaskIds[index])))
  ) {
    throw new Error('Operation plan identity mismatch.');
  }
  return plan;
}

export async function encryptPreviousValues(input: {
  keyBase64: string | undefined;
  portalId: string;
  ownerId: string;
  operationId: string;
  taskId: string;
  beforeVersion: string;
  values: Record<string, unknown>;
}): Promise<{ ciphertext: string; nonce: string; keyVersion: string; payloadVersion: number }> {
  if (!hasValidOperationPlanKey(input.keyBase64)) {
    throw new RuntimeConfigurationError('Operation result key is invalid.');
  }
  const key = await crypto.subtle.importKey(
    'raw',
    decodeBase64(input.keyBase64 ?? ''),
    'AES-GCM',
    false,
    ['encrypt'],
  );
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const associatedData = new TextEncoder().encode(
    `task-commander:previous-values:v1:${input.portalId}:${input.ownerId}:${input.operationId}:${input.taskId}:${input.beforeVersion}`,
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: associatedData },
      key,
      new TextEncoder().encode(JSON.stringify(input.values)),
    ),
  );
  return {
    ciphertext: encodeBase64(ciphertext),
    nonce: encodeBase64(nonce),
    keyVersion: 'v1',
    payloadVersion: 1,
  };
}
