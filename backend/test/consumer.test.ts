import { createExecutionContext, createMessageBatch, env, getQueueResult } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import consumer, { consumeRuntimeProbeBatch } from '../src/consumer';

const queueName = 'task-commander-test-operations-v1';

describe('runtime probe consumer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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

  it('retries an unknown probe schema without writing an artifact', async () => {
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
      retryMessages: [{ msgId: 'probe-invalid' }],
      explicitAcks: [],
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
});
