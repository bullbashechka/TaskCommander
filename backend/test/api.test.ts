import { describe, expect, it } from 'vitest';

import { healthResponse } from '@task-commander/contracts';
import { api } from '../src/api';

const configuredLocalEnvironment = {
  APP_ENV: 'local',
  BITRIX_ADAPTER: 'mock',
  SUPABASE_URL: 'https://dev.supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  LOCAL_SUPABASE_ALLOWED_HOSTS: 'dev.supabase.test',
};

describe('foundation API', () => {
  it('returns the health contract', async () => {
    const response = await api.request(
      'https://example.test/api/health',
      undefined,
      configuredLocalEnvironment,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toEqual({
      ...healthResponse,
      readiness: 'degraded',
      subsystems: {
        ...healthResponse.subsystems,
        queue: 'invalid_configuration',
        r2: 'invalid_configuration',
        supabase: 'ready',
      },
    });
  });

  it('reports an incomplete Supabase configuration without exposing its secret', async () => {
    const response = await api.request('https://example.test/api/health', undefined, {
      APP_ENV: 'local',
      BITRIX_ADAPTER: 'mock',
      SUPABASE_URL: 'https://dev.supabase.test',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    });

    expect(response.status).toBe(200);
    const responseText = await response.clone().text();
    await expect(response.json()).resolves.toEqual({
      ...healthResponse,
      subsystems: {
        ...healthResponse.subsystems,
        queue: 'invalid_configuration',
        r2: 'invalid_configuration',
        supabase: 'invalid_configuration',
      },
    });
    expect(responseText).not.toContain('test-service-role-key');
  });

  it('reports missing baseline configuration without exposing implementation details', async () => {
    const response = await api.request('https://example.test/api/health', undefined, {});

    await expect(response.json()).resolves.toEqual({
      ...healthResponse,
      subsystems: {
        ...healthResponse.subsystems,
        runtime: 'invalid_configuration',
        queue: 'invalid_configuration',
        r2: 'invalid_configuration',
        cron: 'invalid_configuration',
        bitrix: 'invalid_configuration',
      },
    });
  });

  it('does not expose the probe route outside local mode', async () => {
    const response = await api.request(
      'https://example.test/api/_runtime/probe',
      {
        method: 'POST',
      },
      {},
    );

    expect(response.status).toBe(404);
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
