import { createExecutionContext, createMessageBatch, env, getQueueResult } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import consumer, { consumeQueueBatch, consumeRuntimeProbeBatch } from '../src/consumer';

const queueName = 'task-commander-test-operations-v1';

describe('runtime probe consumer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries an operation envelope until the execution consumer is installed', async () => {
    const batch = createMessageBatch(queueName, [
      {
        id: 'queued-operation',
        timestamp: new Date(),
        attempts: 1,
        body: {
          schemaVersion: 1,
          messageId: '123e4567-e89b-42d3-a456-426614174001',
          kind: 'operation.execute',
          portalId: 'portal-1',
          operationId: '123e4567-e89b-42d3-a456-426614174000',
          launchAttempt: 1,
          createdAt: '2026-09-28T00:00:00.000Z',
        },
      },
    ]);
    const context = createExecutionContext();
    await consumer.queue!(batch, env, context);
    await expect(getQueueResult(batch, context)).resolves.toMatchObject({
      retryMessages: [{ msgId: 'queued-operation' }],
      explicitAcks: [],
    });
  });

  it('acknowledges a valid probe after the local R2 round trip', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const artifactKey = 'v1/runtime-probe/json/probe-valid.json';
    const batch = createMessageBatch(queueName, [
      {
        id: 'queue-probe-valid',
        timestamp: new Date(),
        attempts: 1,
        body: {
          schemaVersion: 1,
          messageId: 'probe-valid',
          kind: 'runtime.probe',
          createdAt: '2026-08-10T00:00:00.000Z',
          payload: { artifactKey },
        },
      },
    ]);
    const context = createExecutionContext();

    await consumer.queue!(batch, env, context);

    await expect(getQueueResult(batch, context)).resolves.toEqual({
      outcome: 'ok',
      retryBatch: { retry: false },
      ackAll: false,
      retryMessages: [],
      explicitAcks: ['queue-probe-valid'],
    });
    await expect(env.REPORTS_BUCKET.get(artifactKey)).resolves.toBeNull();
    expect(info).toHaveBeenCalledWith(
      JSON.stringify({ event: 'runtime_probe_consumed', messageId: 'probe-valid' }),
    );
  });

  it('acknowledges an unknown probe schema without writing an artifact', async () => {
    const batch = createMessageBatch(queueName, [
      {
        id: 'probe-invalid',
        timestamp: new Date(),
        attempts: 1,
        body: {
          schemaVersion: 2,
          messageId: 'probe-invalid',
          kind: 'runtime.probe',
          createdAt: '2026-08-10T00:00:00.000Z',
          payload: { artifactKey: 'v1/runtime-probe/json/probe-invalid.json' },
        },
      },
    ]);
    const context = createExecutionContext();

    await consumer.queue!(batch, env, context);

    await expect(getQueueResult(batch, context)).resolves.toEqual({
      outcome: 'ok',
      retryBatch: { retry: false },
      ackAll: false,
      retryMessages: [],
      explicitAcks: ['probe-invalid'],
    });
    await expect(
      env.REPORTS_BUCKET.get('v1/runtime-probe/json/probe-invalid.json'),
    ).resolves.toBeNull();
  });

  it('retries a probe with an unavailable R2 binding as a configuration error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const batch = createMessageBatch(queueName, [
      {
        id: 'probe-without-r2',
        timestamp: new Date(),
        attempts: 1,
        body: {
          schemaVersion: 1,
          messageId: 'probe-without-r2',
          kind: 'runtime.probe',
          createdAt: '2026-08-10T00:00:00.000Z',
          payload: { artifactKey: 'v1/runtime-probe/json/probe-without-r2.json' },
        },
      },
    ]);
    const context = createExecutionContext();

    await consumeRuntimeProbeBatch(batch, { ...env, REPORTS_BUCKET: undefined });

    await expect(getQueueResult(batch, context)).resolves.toEqual({
      outcome: 'ok',
      retryBatch: { retry: false },
      ackAll: false,
      retryMessages: [{ msgId: 'probe-without-r2' }],
      explicitAcks: [],
    });
    expect(error).toHaveBeenCalledWith(
      JSON.stringify({ event: 'runtime_probe_configuration_error', messageId: 'probe-without-r2' }),
    );
  });

  it('acknowledges messages from an unknown queue without dispatching a handler', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const batch = createMessageBatch('task-commander-test-unknown-v1', [
      {
        id: 'unknown-queue-message',
        timestamp: new Date(),
        attempts: 1,
        body: { schemaVersion: 1 },
      },
    ]);
    const context = createExecutionContext();

    await consumer.queue!(batch, env, context);

    await expect(getQueueResult(batch, context)).resolves.toMatchObject({
      retryMessages: [],
      explicitAcks: ['unknown-queue-message'],
    });
    expect(error).toHaveBeenCalledWith(
      JSON.stringify({ event: 'queue_rejected', queue: 'task-commander-test-unknown-v1' }),
    );
  });

  it('acknowledges a malformed access command without constructing data dependencies', async () => {
    const batch = createMessageBatch('task-commander-test-access-v1', [
      {
        id: 'malformed-access-command',
        timestamp: new Date(),
        attempts: 1,
        body: { schemaVersion: 999 },
      },
    ]);
    const context = createExecutionContext();

    await consumeQueueBatch(batch, {});

    await expect(getQueueResult(batch, context)).resolves.toMatchObject({
      retryMessages: [],
      explicitAcks: ['malformed-access-command'],
    });
  });

  it('retries a final-attempt valid access command when the repository is unavailable', async () => {
    const batch = createMessageBatch('task-commander-test-access-v1', [
      {
        id: 'valid-access-command-without-repository',
        timestamp: new Date(),
        attempts: 5,
        body: {
          schemaVersion: 1,
          messageId: '123e4567-e89b-42d3-a456-426614174000',
          kind: 'access.command.execute',
          portalId: 'portal-1',
          commandId: '223e4567-e89b-42d3-a456-426614174000',
          createdAt: '2026-08-18T00:00:00.000Z',
        },
      },
    ]);
    const context = createExecutionContext();

    await consumeQueueBatch(batch, {});

    await expect(getQueueResult(batch, context)).resolves.toMatchObject({
      retryMessages: [{ msgId: 'valid-access-command-without-repository' }],
      explicitAcks: [],
    });
  });

  it('does not acknowledge an accepted command when its final claim attempt fails', async () => {
    const batch = createMessageBatch('task-commander-test-access-v1', [
      {
        id: 'accepted-command-claim-failed',
        timestamp: new Date(),
        attempts: 5,
        body: {
          schemaVersion: 1,
          messageId: '323e4567-e89b-42d3-a456-426614174000',
          kind: 'access.command.execute',
          portalId: 'portal-1',
          commandId: '423e4567-e89b-42d3-a456-426614174000',
          createdAt: '2026-08-18T00:00:00.000Z',
        },
      },
    ]);
    const context = createExecutionContext();
    const repository = {
      readCommand: vi.fn().mockResolvedValue({
        command: { state: 'accepted', state_version: 1 },
        targets: [],
      }),
      claimCommand: vi.fn().mockRejectedValue(new Error('temporary database failure')),
    };

    await consumeQueueBatch(batch, {}, () => repository as never);

    await expect(getQueueResult(batch, context)).resolves.toMatchObject({
      retryMessages: [{ msgId: 'accepted-command-claim-failed' }],
      explicitAcks: [],
    });
    expect(repository.readCommand).toHaveBeenCalledTimes(2);
  });
});
