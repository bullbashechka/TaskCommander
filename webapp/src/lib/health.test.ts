import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchHealth } from './health';

describe('fetchHealth', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a valid health response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: 'ok', service: 'task-commander-api' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(fetchHealth()).resolves.toEqual({ status: 'ok', service: 'task-commander-api' });
  });

  it('rejects an invalid API response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(fetchHealth()).rejects.toThrow('API вернул неожиданный ответ.');
  });
});
