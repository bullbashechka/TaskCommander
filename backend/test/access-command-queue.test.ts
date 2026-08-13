import { describe, expect, it } from 'vitest';

import {
  ACCESS_COMMAND_QUEUE_KIND,
  ACCESS_COMMAND_QUEUE_SCHEMA_VERSION,
  accessCommandQueueMessageSchema,
  createAccessCommandQueueMessage,
} from '../src/contracts/access-command-queue';

describe('access command queue contract', () => {
  it('creates a strict tenant-scoped message without an authority payload', () => {
    const message = createAccessCommandQueueMessage({
      portalId: 'portal-1',
      commandId: '123e4567-e89b-42d3-a456-426614174000',
      now: new Date('2026-08-13T10:00:00.000Z'),
    });

    expect(message).toMatchObject({
      schemaVersion: ACCESS_COMMAND_QUEUE_SCHEMA_VERSION,
      kind: ACCESS_COMMAND_QUEUE_KIND,
      portalId: 'portal-1',
      commandId: '123e4567-e89b-42d3-a456-426614174000',
      createdAt: '2026-08-13T10:00:00.000Z',
    });
    expect(message).not.toHaveProperty('actorId');
    expect(() => accessCommandQueueMessageSchema.parse({ ...message, permissions: ['manage_access'] })).toThrow();
  });
});
