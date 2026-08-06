import { describe, expect, it } from 'vitest';

import { healthResponse, isHealthResponse } from './index';

describe('health contract', () => {
  it('accepts the canonical response', () => {
    expect(isHealthResponse(healthResponse)).toBe(true);
  });

  it('rejects an incomplete response', () => {
    expect(isHealthResponse({ status: 'ok' })).toBe(false);
  });
});
