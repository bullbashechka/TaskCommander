import { describe, expect, it } from 'vitest';

import { apiErrorResponseSchema, sessionResponseSchema } from '@task-commander/contracts';

import { createSessionService } from '../src/auth/session-service';
import type { BitrixFailure } from '../src/integrations/bitrix/contract';
import {
  createMockLaunchContext,
  createSessionToken,
  type CreateMockLaunchContextInput,
} from '../src/auth/signed-token';
import { api } from '../src/api';
import { createMockBitrixAdapter } from '../src/integrations/bitrix/mock';

const mockLaunchSecret = 'test-mock-launch-signing-secret-0001';
const sessionSecret = 'test-session-signing-secret-0000001';
const fixedNow = new Date('2026-08-12T10:00:00.000Z');
const fixedTimestamp = Math.floor(fixedNow.getTime() / 1_000);
const sessionId = '123e4567-e89b-42d3-a456-426614174000';
const environment = {
  APP_ENV: 'local',
  BITRIX_ADAPTER: 'mock',
  MOCK_LAUNCH_SIGNING_SECRET: mockLaunchSecret,
  SESSION_SIGNING_SECRET: sessionSecret,
};

async function launchContext(
  userId: string,
  overrides: Partial<CreateMockLaunchContextInput> = {},
): Promise<string> {
  return createMockLaunchContext(
    {
      portalId: 'portal-1',
      userId,
      issuedAt: fixedTimestamp,
      expiresAt: fixedTimestamp + 300,
      nonce: 'nonce-for-session-tests-0000000001',
      ...overrides,
    },
    mockLaunchSecret,
  );
}

async function liveLaunchContext(
  userId: string,
  overrides: Partial<CreateMockLaunchContextInput> = {},
): Promise<string> {
  return createMockLaunchContext(
    {
      portalId: 'portal-1',
      userId,
      ...overrides,
    },
    mockLaunchSecret,
  );
}

function cookieValue(setCookie: string | null): string {
  if (setCookie === null) throw new Error('Session cookie is absent.');
  const value = setCookie.split(';')[0];
  if (value === undefined) throw new Error('Session cookie is malformed.');
  return value;
}

describe('local Bitrix identity session', () => {
  it('creates a safe session for an active operator and does not leak the launch context', async () => {
    const context = await liveLaunchContext('10');
    const response = await api.request(
      'https://example.test/api/session',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ launchContext: context }),
      },
      environment,
    );

    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const responseText = await response.clone().text();
    expect(responseText).not.toContain(context);
    expect(responseText).not.toContain(mockLaunchSecret);
    expect(responseText).not.toContain(sessionSecret);
    expect(sessionResponseSchema.parse(await response.json())).toEqual({
      principal: {
        portalId: 'portal-1',
        userId: '10',
        displayName: 'Operator',
        isBitrixAdmin: false,
      },
    });
    expect(response.headers.get('set-cookie')).toMatch(
      /^tc_session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; Path=\/api; HttpOnly; Secure; SameSite=Lax; Max-Age=900$/,
    );
  });

  it('identifies a Bitrix administrator without calculating application permissions', async () => {
    const response = await api.request(
      'https://example.test/api/session',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ launchContext: await liveLaunchContext('1') }),
      },
      environment,
    );

    expect(sessionResponseSchema.parse(await response.json()).principal).toEqual({
      portalId: 'portal-1',
      userId: '1',
      displayName: 'Portal administrator',
      isBitrixAdmin: true,
    });
  });

  it('rejects forged, expired, incomplete, wrong-version, and wrong-audience launch contexts', async () => {
    const validContext = await liveLaunchContext('10');
    const forgedContext = `${validContext.slice(0, -1)}${validContext.endsWith('A') ? 'B' : 'A'}`;
    const expiredAt = Math.floor(Date.now() / 1_000) - 300;
    const expiredContext = await createMockLaunchContext(
      {
        portalId: 'portal-1',
        userId: '10',
        issuedAt: expiredAt - 300,
        expiresAt: expiredAt,
        nonce: 'nonce-for-session-tests-0000000001',
      },
      mockLaunchSecret,
    );
    const unsupportedVersion = await liveLaunchContext('10', { version: 2 });
    const wrongAudience = await liveLaunchContext('10', { audience: 'other-service' });
    const missingNonce = await liveLaunchContext('10', { claims: { nonce: undefined } });
    const extraClaim = await liveLaunchContext('10', { claims: { unexpected: true } });
    const currentTimestamp = Math.floor(Date.now() / 1_000);
    const invalidTtl = await liveLaunchContext('10', {
      issuedAt: currentTimestamp,
      expiresAt: currentTimestamp + 299,
    });
    const futureIssuedAt = await liveLaunchContext('10', {
      issuedAt: currentTimestamp + 61,
      expiresAt: currentTimestamp + 361,
    });
    const wrongHeaderType = await liveLaunchContext('10', { headerType: 'TC-OTHER' });

    for (const context of [
      forgedContext,
      expiredContext,
      'incomplete-launch-context',
      unsupportedVersion,
      wrongAudience,
      missingNonce,
      extraClaim,
      invalidTtl,
      futureIssuedAt,
      wrongHeaderType,
    ]) {
      const response = await api.request(
        'https://example.test/api/session',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ launchContext: context }),
        },
        environment,
      );

      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe(
        'UNAUTHENTICATED',
      );
    }
  });

  it('rejects an inactive or absent mock user before issuing a cookie', async () => {
    for (const userId of ['99', '999']) {
      const response = await api.request(
        'https://example.test/api/session',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ launchContext: await liveLaunchContext(userId) }),
        },
        environment,
      );

      expect(response.status).toBe(userId === '99' ? 403 : 401);
      expect(response.headers.get('set-cookie')).toBeNull();
    }
  });

  it('rechecks the current user and creates a distinct session on every login', async () => {
    let adapterCalls = 0;
    let sessionCalls = 0;
    const service = createSessionService(environment, {
      now: () => fixedNow,
      createSessionId: () => {
        sessionCalls += 1;
        return sessionCalls === 1
          ? '123e4567-e89b-42d3-a456-426614174000'
          : '123e4567-e89b-42d3-a456-426614174001';
      },
      createAdapter: (_env, input) => {
        adapterCalls += 1;
        const adapter = createMockBitrixAdapter({ currentUserId: input.currentUserId });
        if (adapterCalls === 3) {
          const user = adapter.state.users.get('10');
          if (user) user.isActive = false;
        }
        return adapter;
      },
    });
    const context = await launchContext('10');

    const first = await service.create(context);
    const second = await service.create(context);
    await expect(service.create(context)).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });

    expect(adapterCalls).toBe(3);
    expect(first.cookie).not.toBe(second.cookie);
  });

  it('rejects an adapter identity mismatch safely', async () => {
    const mismatch = createSessionService(environment, {
      now: () => fixedNow,
      createAdapter: () => createMockBitrixAdapter({ currentUserId: '1' }),
    });
    const context = await launchContext('10');

    await expect(mismatch.create(context)).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHENTICATED',
    });
  });

  it('maps every adapter failure to a safe public error without exposing adapter details', async () => {
    const cases: readonly { failure: BitrixFailure; status: number; code: string }[] = [
      { failure: { kind: 'not_authenticated' }, status: 401, code: 'UNAUTHENTICATED' },
      { failure: { kind: 'permission_denied' }, status: 403, code: 'FORBIDDEN' },
      { failure: { kind: 'not_found_or_forbidden' }, status: 401, code: 'UNAUTHENTICATED' },
      {
        failure: { kind: 'rate_limited', limit: 'intensity', retryAt: null },
        status: 429,
        code: 'RATE_LIMITED',
      },
      {
        failure: { kind: 'temporary_failure', reasonCode: 'mock_temporary' },
        status: 503,
        code: 'UPSTREAM_UNAVAILABLE',
      },
      {
        failure: { kind: 'permanent_failure', reasonCode: 'mock_permanent', fieldIds: [] },
        status: 503,
        code: 'UPSTREAM_UNAVAILABLE',
      },
      { failure: { kind: 'invalid_external_response' }, status: 503, code: 'UPSTREAM_UNAVAILABLE' },
      {
        failure: { kind: 'unsupported_capability', capability: 'mock_capability' },
        status: 503,
        code: 'UPSTREAM_UNAVAILABLE',
      },
    ];
    const context = await launchContext('10');

    for (const testCase of cases) {
      const service = createSessionService(environment, {
        now: () => fixedNow,
        createAdapter: () => {
          const adapter = createMockBitrixAdapter({ currentUserId: '10' });
          return {
            ...adapter,
            users: {
              ...adapter.users,
              getCurrent: async () => ({ ok: false as const, failure: testCase.failure }),
            },
          };
        },
      });

      await expect(service.create(context)).rejects.toMatchObject({
        status: testCase.status,
        code: testCase.code,
      });
    }
  });

  it('fails session creation and reads safely when identity configuration is invalid', async () => {
    const invalidEnvironments = [
      { ...environment, MOCK_LAUNCH_SIGNING_SECRET: undefined },
      { ...environment, SESSION_SIGNING_SECRET: 'too-short' },
      { ...environment, SESSION_SIGNING_SECRET: mockLaunchSecret },
    ];

    for (const invalidEnvironment of invalidEnvironments) {
      const service = createSessionService(invalidEnvironment, { now: () => fixedNow });
      await expect(service.create(await launchContext('10'))).rejects.toMatchObject({
        status: 503,
        code: 'UPSTREAM_UNAVAILABLE',
      });
      await expect(service.read(null)).rejects.toMatchObject({
        status: 503,
        code: 'UPSTREAM_UNAVAILABLE',
      });
    }

    const response = await api.request(
      'https://example.test/api/session',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ launchContext: await liveLaunchContext('10') }),
      },
      { APP_ENV: 'local', BITRIX_ADAPTER: 'mock' },
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(JSON.stringify(await response.json())).not.toContain(mockLaunchSecret);
  });

  it('returns only the safe principal from GET and rejects missing, duplicate, or expired cookies', async () => {
    const login = await api.request(
      'https://example.test/api/session',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ launchContext: await liveLaunchContext('10') }),
      },
      environment,
    );
    const cookie = cookieValue(login.headers.get('set-cookie'));
    const get = await api.request(
      'https://example.test/api/session',
      { headers: { cookie } },
      environment,
    );

    expect(sessionResponseSchema.parse(await get.json())).toEqual({
      principal: {
        portalId: 'portal-1',
        userId: '10',
        displayName: 'Operator',
        isBitrixAdmin: false,
      },
    });
    expect(get.headers.get('cache-control')).toBe('no-store');
    expect(get.headers.get('vary')).toBe('Cookie');

    const expiredToken = await createSessionToken(
      { portalId: 'portal-1', userId: '10', displayName: 'Operator', isBitrixAdmin: false },
      sessionSecret,
      new Date(Date.now() - 16 * 60 * 1_000),
      sessionId,
    );
    const tamperedCookie = `${cookie.slice(0, -1)}${cookie.endsWith('A') ? 'B' : 'A'}`;
    for (const cookieHeader of [
      null,
      `${cookie}; ${cookie}`,
      `tc_session=${expiredToken}`,
      tamperedCookie,
    ]) {
      const response = await api.request(
        'https://example.test/api/session',
        cookieHeader === null ? undefined : { headers: { cookie: cookieHeader } },
        environment,
      );
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('clears the session cookie without returning session data', async () => {
    const response = await api.request(
      'https://example.test/api/session',
      { method: 'DELETE' },
      environment,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('');
    expect(response.headers.get('set-cookie')).toContain(
      'tc_session=; Path=/api; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
    );
  });

  it('rejects oversized, invalid UTF-8, malformed length, or non-strict session requests', async () => {
    for (const body of [
      JSON.stringify({ launchContext: await liveLaunchContext('10'), extra: true }),
      JSON.stringify({ launchContext: '' }),
      JSON.stringify({ launchContext: 'x'.repeat(4_097) }),
    ]) {
      const response = await api.request(
        'https://example.test/api/session',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body },
        environment,
      );
      expect(response.status).toBe(400);
    }

    for (const request of [
      {
        body: new Uint8Array(4_353),
        headers: { 'content-type': 'application/json' },
      },
      {
        body: new Uint8Array([0xff]),
        headers: { 'content-type': 'application/json' },
      },
      {
        body: JSON.stringify({ launchContext: await liveLaunchContext('10') }),
        headers: { 'content-length': 'not-a-number', 'content-type': 'application/json' },
      },
    ]) {
      const response = await api.request(
        'https://example.test/api/session',
        { method: 'POST', ...request },
        environment,
      );
      expect(response.status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });
});
