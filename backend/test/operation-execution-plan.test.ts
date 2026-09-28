import { describe, expect, it } from 'vitest';

import type { BulkOperationDraft, PreflightPreview } from '@task-commander/contracts';

import { encryptExecutionPlan } from '../src/task-changes/execution-plan';

describe('private operation execution plan', () => {
  it('encrypts changes and preflight with purpose-bound owner and token', async () => {
    const keyBytes = new Uint8Array(32).fill(17);
    const keyBase64 = btoa(String.fromCharCode(...keyBytes));
    const draft = {
      id: '10000000-0000-4000-8000-000000000021',
      revision: 2,
      selectedTaskIds: ['42'],
      filters: [],
      sort: { field: 'id', direction: 'asc' },
      changes: [{ fieldId: 'title', kind: 'text', action: 'set', value: 'After' }],
    } as unknown as BulkOperationDraft;
    const preview = {
      entries: [
        { taskId: '42', currentValues: { title: 'Before' }, targetValues: { title: 'After' } },
      ],
    } as unknown as PreflightPreview;
    const encrypted = await encryptExecutionPlan({
      keyBase64,
      portalId: 'portal-1',
      ownerId: '8001',
      token: '123e4567-e89b-42d3-a456-426614174001',
      draft,
      preview,
    });
    expect(encrypted.ciphertext).not.toContain('Before');
    expect(encrypted.ciphertext).not.toContain('After');
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
    const ciphertext = Uint8Array.from(atob(encrypted.ciphertext), (value) => value.charCodeAt(0));
    const nonce = Uint8Array.from(atob(encrypted.nonce), (value) => value.charCodeAt(0));
    const aad = (ownerId: string) =>
      new TextEncoder().encode(
        `task-commander:operation-plan:v1:portal-1:${ownerId}:${draft.id}:${draft.revision}:123e4567-e89b-42d3-a456-426614174001`,
      );
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad('8001') },
      key,
      ciphertext,
    );
    expect(JSON.parse(new TextDecoder().decode(decrypted))).toMatchObject({
      changes: draft.changes,
      filters: draft.filters,
      sort: draft.sort,
      preflight: preview,
    });
    await expect(
      crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: aad('8002') },
        key,
        ciphertext,
      ),
    ).rejects.toThrow();
  });
});
