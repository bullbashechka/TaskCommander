import { describe, expect, it } from 'vitest';

import type { BulkOperationDraft, PreflightPreview } from '@task-commander/contracts';

import {
  decryptExecutionPlan,
  encryptExecutionPlan,
  encryptPreviousValues,
} from '../src/task-changes/execution-plan';

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

  it('decrypts only the matching operation identity and keeps previous values purpose-bound', async () => {
    const keyBytes = new Uint8Array(32).fill(19);
    const keyBase64 = btoa(String.fromCharCode(...keyBytes));
    const draft = {
      id: '10000000-0000-4000-8000-000000000021',
      ownerId: '8001',
      revision: 2,
      status: 'awaiting_confirmation',
      selectedTaskIds: ['42'],
      filters: [],
      sort: { fieldId: 'deadline', direction: 'asc' },
      changes: [{ fieldId: 'title', kind: 'text', action: 'set', value: 'After' }],
      createdAt: '2026-09-28T00:00:00.000Z',
      updatedAt: '2026-09-28T00:00:00.000Z',
      expiresAt: '2026-09-29T00:00:00.000Z',
    } as BulkOperationDraft;
    const preview = {
      draftId: draft.id,
      sourceDraftRevision: 1,
      draftRevision: 2,
      actorAccessVersion: 1,
      checkedAt: '2026-09-28T00:00:00.000Z',
      canProceed: true,
      entries: [
        {
          taskId: '42',
          title: 'Task',
          taskUrl: 'https://portal.bitrix24.ru/tasks/42',
          disposition: 'eligible',
          changedFieldIds: ['title'],
          reasonCode: null,
          reasonMessage: null,
          relevantVersion: 'before-version',
          currentValues: { title: 'Before' },
          targetValues: { title: 'After' },
        },
      ],
      summary: {
        selected: 1,
        eligible: 1,
        excluded: 0,
        unchanged: 0,
        successful: 0,
        failed: 0,
        unconfirmed: 0,
        conflicted: 0,
        partiallyApplied: 0,
        notProcessed: 0,
      },
    } as PreflightPreview;
    const identity = {
      keyBase64,
      portalId: 'portal-1',
      ownerId: '8001',
      token: '123e4567-e89b-42d3-a456-426614174001',
      draftId: draft.id,
      draftRevision: draft.revision,
    };
    const encrypted = await encryptExecutionPlan({
      ...identity,
      draft,
      preview,
    });
    await expect(decryptExecutionPlan({ ...identity, ...encrypted })).resolves.toMatchObject({
      draftId: draft.id,
      changes: draft.changes,
      preflight: preview,
    });
    await expect(
      decryptExecutionPlan({ ...identity, ownerId: '8002', ...encrypted }),
    ).rejects.toThrow();
    await expect(
      decryptExecutionPlan({ ...identity, token: crypto.randomUUID(), ...encrypted }),
    ).rejects.toThrow();

    const previous = await encryptPreviousValues({
      keyBase64,
      portalId: 'portal-1',
      ownerId: '8001',
      operationId: '123e4567-e89b-42d3-a456-426614174002',
      taskId: '42',
      beforeVersion: 'mock:0',
      values: { title: 'Before' },
    });
    expect(previous.ciphertext).not.toContain('Before');
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: Uint8Array.from(atob(previous.nonce), (value) => value.charCodeAt(0)),
        additionalData: new TextEncoder().encode(
          'task-commander:previous-values:v1:portal-1:8001:123e4567-e89b-42d3-a456-426614174002:42:mock:0',
        ),
      },
      key,
      Uint8Array.from(atob(previous.ciphertext), (value) => value.charCodeAt(0)),
    );
    expect(JSON.parse(new TextDecoder().decode(plaintext))).toEqual({ title: 'Before' });
  });
});
