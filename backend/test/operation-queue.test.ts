import { describe, expect, it } from 'vitest';

import {
  createOperationQueueMessage,
  operationQueueMessageSchema,
} from '../src/contracts/operation-queue';

describe('operation queue contract', () => {
  it('serializes the minimal versioned operation envelope', () => {
    const message = createOperationQueueMessage({
      portalId: 'portal-1',
      operationId: '123e4567-e89b-42d3-a456-426614174000',
      launchAttempt: 1,
      messageId: '123e4567-e89b-42d3-a456-426614174001',
      createdAt: '2026-09-28T00:00:00.000Z',
    });

    expect(operationQueueMessageSchema.parse(JSON.parse(JSON.stringify(message)))).toEqual(message);
    expect(createOperationQueueMessage({ ...message })).toEqual(message);
  });

  it('rejects an unsupported queue message kind', () => {
    expect(
      operationQueueMessageSchema.safeParse({
        schemaVersion: 1,
        messageId: '123e4567-e89b-42d3-a456-426614174000',
        kind: 'operation.unsupported',
        operationId: '123e4567-e89b-42d3-a456-426614174001',
        createdAt: '2026-08-10T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});
