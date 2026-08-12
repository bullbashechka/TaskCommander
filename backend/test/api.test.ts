import { describe, expect, it } from 'vitest';

import { apiErrorResponseSchema, healthResponse } from '@task-commander/contracts';
import { api } from '../src/api';

const configuredLocalEnvironment = {
  APP_ENV: 'local',
  BITRIX_ADAPTER: 'mock',
  MOCK_LAUNCH_SIGNING_SECRET: 'test-mock-launch-signing-secret-0001',
  SUPABASE_URL: 'https://dev.supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  LOCAL_SUPABASE_ALLOWED_HOSTS: 'dev.supabase.test',
  SESSION_SIGNING_SECRET: 'test-session-signing-secret-0000001',
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
      MOCK_LAUNCH_SIGNING_SECRET: 'test-mock-launch-signing-secret-0001',
      SUPABASE_URL: 'https://dev.supabase.test',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
      SESSION_SIGNING_SECRET: 'test-session-signing-secret-0000001',
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

  it('rejects an invalid local probe request with a safe correlation ID', async () => {
    const response = await api.request(
      'https://example.test/api/_runtime/probe',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ unexpected: true }),
      },
      configuredLocalEnvironment,
    );

    expect(response.status).toBe(400);
    const body = apiErrorResponseSchema.parse(await response.json());
    expect(body).toEqual({
      error: {
        code: 'INVALID_REQUEST',
        message: 'Некорректный запрос.',
        correlationId: expect.stringMatching(/^TC-[0-9a-f-]+$/i),
        fieldErrors: [
          {
            path: 'unexpected',
            code: 'unrecognized_key',
            message: 'Поле не поддерживается.',
          },
        ],
      },
    });
    expect(response.headers.get('x-correlation-id')).toBe(body.error.correlationId);
  });

  it('returns JSON for an unknown API route', async () => {
    const response = await api.request('https://example.test/api/missing');

    expect(response.status).toBe(404);
    const body = apiErrorResponseSchema.parse(await response.json());
    expect(body).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Маршрут API не найден.',
        correlationId: expect.stringMatching(/^TC-[0-9a-f-]+$/i),
      },
    });
    expect(response.headers.get('x-correlation-id')).toBe(body.error.correlationId);
  });
});
