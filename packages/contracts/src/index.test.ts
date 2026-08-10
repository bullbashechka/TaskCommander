import { describe, expect, it } from 'vitest';

import { healthResponse, isHealthResponse } from './index';

describe('health contract', () => {
  it('accepts the canonical response', () => {
    expect(isHealthResponse(healthResponse)).toBe(true);
  });

  it('rejects a response without runtime readiness', () => {
    expect(isHealthResponse({ status: 'ok', service: 'task-commander-api' })).toBe(false);
  });
});
