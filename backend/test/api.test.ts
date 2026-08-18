import { describe, expect, it, vi } from 'vitest';

import { apiErrorResponseSchema, livenessResponse } from '@task-commander/contracts';
import { api } from '../src/api';

const probeToken = 'test-runtime-probe-token-0000000001';

const configuredLocalEnvironment = {
  APP_ENV: 'local',
  APP_ORIGIN: 'https://example.test',
  BITRIX_ADAPTER: 'mock',
  MOCK_LAUNCH_SIGNING_SECRET: 'test-mock-launch-signing-secret-0001',
  SUPABASE_URL: 'https://dev.supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  SUPABASE_ALLOWED_ORIGINS: 'https://dev.supabase.test',
  SESSION_SIGNING_SECRET: 'test-session-signing-secret-0000001',
  INTERNAL_READINESS_TOKEN: 'test-readiness-token-000000000000000001',
  SESSION_RATE_LIMITER: { limit: async () => ({ success: true }) },
  PROBE_RATE_LIMITER: { limit: async () => ({ success: true }) },
  ACCESS_FANOUT_RATE_LIMITER: { limit: async () => ({ success: true }) },
  ENABLE_LOCAL_RUNTIME_PROBE: 'true',
  LOCAL_RUNTIME_PROBE_TOKEN: probeToken,
};

const trustedJsonHeaders = {
  'content-type': 'application/json',
  origin: 'https://example.test',
  'sec-fetch-site': 'same-origin',
  'x-task-commander-probe-token': probeToken,
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
    expect(response.headers.get('content-security-policy')).toContain("object-src 'none'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    await expect(response.json()).resolves.toEqual(livenessResponse);
  });

  it('adds HSTS to every non-local response', async () => {
    const response = await api.request('https://app.example.test/api/health', undefined, {
      APP_ENV: 'production',
      APP_ORIGIN: 'https://app.example.test',
    });

    expect(response.headers.get('strict-transport-security')).toBe(
      'max-age=31536000; includeSubDomains',
    );
  });

  it('allows both portal and media origins in the image CSP', async () => {
    const response = await api.request('https://app.example.test/api/health', undefined, {
      APP_ENV: 'production',
      APP_ORIGIN: 'https://app.example.test',
      BITRIX_PORTAL_ORIGIN: 'https://portal.bitrix24.ru',
      BITRIX_MEDIA_ALLOWED_ORIGINS: 'https://media.bitrix24.ru',
    });

    const policy = response.headers.get('content-security-policy');
    expect(policy).toContain("img-src 'self' https://portal.bitrix24.ru https://media.bitrix24.ru");
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
    await expect(response.json()).resolves.toEqual(livenessResponse);
    expect(responseText).not.toContain('test-service-role-key');
  });

  it('reports missing baseline configuration without exposing implementation details', async () => {
    const response = await api.request('https://example.test/api/health', undefined, {});

    await expect(response.json()).resolves.toEqual(livenessResponse);
  });

  it('rejects an unsafe probe request outside local mode before route execution', async () => {
    const response = await api.request(
      'https://example.test/api/_runtime/probe',
      {
        method: 'POST',
      },
      {},
    );

    expect(response.status).toBe(404);
  });

  it('does not expose a local probe request through a non-loopback origin', async () => {
    const response = await api.request(
      'https://example.test/api/_runtime/probe',
      {
        method: 'POST',
        headers: trustedJsonHeaders,
        body: JSON.stringify({ unexpected: true }),
      },
      configuredLocalEnvironment,
    );

    expect(response.status).toBe(404);
    const body = apiErrorResponseSchema.parse(await response.json());
    expect(body.error.code).toBe('NOT_FOUND');
    expect(response.headers.get('x-correlation-id')).toBe(body.error.correlationId);
  });

  it.each([
    {
      name: 'missing Origin',
      headers: {
        'content-type': 'application/json',
        'sec-fetch-site': 'same-origin',
        'x-task-commander-probe-token': probeToken,
      },
    },
    {
      name: 'foreign Origin',
      headers: { ...trustedJsonHeaders, origin: 'https://attacker.test' },
    },
    {
      name: 'cross-site Fetch Metadata',
      headers: { ...trustedJsonHeaders, 'sec-fetch-site': 'cross-site' },
    },
    {
      name: 'non-JSON media type',
      headers: { ...trustedJsonHeaders, 'content-type': 'text/plain' },
    },
  ])('rejects unsafe requests with $name', async ({ headers }) => {
    const response = await api.request(
      'http://localhost/api/_runtime/probe',
      { method: 'POST', headers, body: '{}' },
      configuredLocalEnvironment,
    );

    expect(response.status).toBe(400);
  });

  it('protects detailed readiness and reports degraded dependencies with 503', async () => {
    const hidden = await api.request(
      'https://example.test/api/_internal/readiness',
      undefined,
      configuredLocalEnvironment,
    );
    expect(hidden.status).toBe(404);
    expect(hidden.headers.get('cache-control')).toBe('no-store');

    const response = await api.request(
      'https://example.test/api/_internal/readiness',
      {
        headers: {
          'x-task-commander-readiness-token': configuredLocalEnvironment.INTERNAL_READINESS_TOKEN,
        },
      },
      configuredLocalEnvironment,
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ readiness: 'degraded' });
  });

  it('does not accept a configured weak readiness token', async () => {
    const response = await api.request(
      'https://example.test/api/_internal/readiness',
      { headers: { 'x-task-commander-readiness-token': 'weak' } },
      { ...configuredLocalEnvironment, INTERNAL_READINESS_TOKEN: 'weak' },
    );

    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('isolates anonymous session limits by Cloudflare client address', async () => {
    const keys: string[] = [];
    const environment = {
      ...configuredLocalEnvironment,
      SESSION_RATE_LIMITER: {
        limit: async ({ key }: { key: string }) => {
          keys.push(key);
          return { success: false };
        },
      },
    };

    for (const address of ['192.0.2.10', '192.0.2.11']) {
      const response = await api.request(
        'https://example.test/api/session',
        {
          method: 'POST',
          headers: { ...trustedJsonHeaders, 'cf-connecting-ip': address },
          body: '{}',
        },
        environment,
      );
      expect(response.status).toBe(429);
    }

    expect(keys).toEqual([
      'https://example.test:192.0.2.10:session',
      'https://example.test:192.0.2.11:session',
    ]);
  });

  it('rejects a rate-limited loopback probe before queue side effects', async () => {
    const queueSend = vi.fn();
    const response = await api.request(
      'http://localhost/api/_runtime/probe',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost',
          'sec-fetch-site': 'same-origin',
          'x-task-commander-probe-token': probeToken,
        },
        body: '{}',
      },
      {
        ...configuredLocalEnvironment,
        APP_ORIGIN: 'http://localhost',
        ENABLE_LOCAL_RUNTIME_PROBE: 'true',
        LOCAL_RUNTIME_PROBE_TOKEN: probeToken,
        PROBE_RATE_LIMITER: { limit: async () => ({ success: false }) },
        OPERATIONS_QUEUE: { send: queueSend },
      },
    );

    expect(response.status).toBe(429);
    expect(queueSend).not.toHaveBeenCalled();
  });

  it('returns JSON for an unknown API route', async () => {
    const response = await api.request(
      'https://example.test/api/missing',
      undefined,
      configuredLocalEnvironment,
    );

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
