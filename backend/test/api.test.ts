import { describe, expect, it } from 'vitest';

import { healthResponse } from '@task-commander/contracts';
import { api } from '../src/api';

describe('foundation API', () => {
  it('returns the health contract', async () => {
    const response = await api.request('https://example.test/api/health');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toEqual(healthResponse);
  });

  it('returns JSON for an unknown API route', async () => {
    const response = await api.request('https://example.test/api/missing');

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Маршрут API не найден.',
      },
    });
  });
});
