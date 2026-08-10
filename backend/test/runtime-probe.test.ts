import { describe, expect, it } from 'vitest';

import { isRuntimeProbeMessage, runtimeProbeMessageSchema } from '../src/runtime/probe';

describe('runtime probe schema', () => {
  const validProbe = {
    schemaVersion: 1,
    messageId: '123e4567-e89b-42d3-a456-426614174000',
    kind: 'runtime.probe',
    createdAt: '2026-08-10T00:00:00.000Z',
    payload: {
      artifactKey: 'v1/runtime-probe/json/123e4567-e89b-42d3-a456-426614174000.json',
    },
  };

  it('accepts the versioned runtime probe envelope', () => {
    expect(runtimeProbeMessageSchema.safeParse(validProbe).success).toBe(true);
    expect(isRuntimeProbeMessage(validProbe)).toBe(true);
  });

  it('rejects unknown properties before a consumer can perform side effects', () => {
    expect(runtimeProbeMessageSchema.safeParse({ ...validProbe, unknown: true }).success).toBe(
      false,
    );
  });
});
