import { sessionPrincipalSchema, type SessionPrincipal } from '@task-commander/contracts';

import { createBitrixAdapter } from '../integrations/bitrix/factory';
import type { BitrixAdapter, BitrixFailure } from '../integrations/bitrix/contract';
import { ApiHttpError } from '../http/errors';
import { hasLocalIdentityConfiguration, type RuntimeEnvironment } from '../runtime/configuration';
import {
  createSessionToken,
  InvalidSignedTokenError,
  verifyMockLaunchContext,
  verifySessionToken,
} from './signed-token';

const sessionCookieName = 'tc_session';
const maximumCookieHeaderLength = 8_192;

export interface SessionServiceDependencies {
  createAdapter?: (env: RuntimeEnvironment, input: { currentUserId: string }) => BitrixAdapter;
  now?: () => Date;
  createSessionId?: () => string;
}

export interface CreatedSession {
  principal: SessionPrincipal;
  cookie: string;
}

function toApiError(failure: BitrixFailure): ApiHttpError {
  switch (failure.kind) {
    case 'not_authenticated':
      return new ApiHttpError(401, 'UNAUTHENTICATED');
    case 'permission_denied':
      return new ApiHttpError(403, 'FORBIDDEN');
    case 'rate_limited':
      return new ApiHttpError(429, 'RATE_LIMITED');
    case 'temporary_failure':
    case 'invalid_external_response':
    case 'unsupported_capability':
      return new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
    case 'not_found_or_forbidden':
      return new ApiHttpError(401, 'UNAUTHENTICATED');
    case 'permanent_failure':
      return new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
  }
}

function extractSessionCookie(cookieHeader: string | null): string | null {
  if (
    cookieHeader === null ||
    cookieHeader.length === 0 ||
    cookieHeader.length > maximumCookieHeaderLength
  ) {
    return null;
  }

  const values = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .flatMap((part) => {
      const separatorIndex = part.indexOf('=');
      return separatorIndex > 0 && part.slice(0, separatorIndex) === sessionCookieName
        ? [part.slice(separatorIndex + 1)]
        : [];
    });
  return values.length === 1 && values[0] !== undefined ? values[0] : null;
}

function serializeSessionCookie(token: string, maximumAgeSeconds: number): string {
  return [
    `${sessionCookieName}=${token}`,
    'Path=/api',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maximumAgeSeconds}`,
  ].join('; ');
}

export function clearSessionCookie(): string {
  return [
    `${sessionCookieName}=`,
    'Path=/api',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ].join('; ');
}

export function createSessionService(
  env: RuntimeEnvironment,
  dependencies: SessionServiceDependencies = {},
) {
  const now = dependencies.now ?? (() => new Date());
  const createAdapter = dependencies.createAdapter ?? createBitrixAdapter;
  const createSessionId = dependencies.createSessionId ?? (() => crypto.randomUUID());

  return {
    async create(launchContext: string): Promise<CreatedSession> {
      if (!hasLocalIdentityConfiguration(env)) {
        throw new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
      }

      let launch;
      try {
        launch = await verifyMockLaunchContext(
          launchContext,
          env.MOCK_LAUNCH_SIGNING_SECRET,
          now(),
        );
      } catch (error) {
        if (error instanceof InvalidSignedTokenError) {
          throw new ApiHttpError(401, 'UNAUTHENTICATED');
        }
        throw error;
      }

      const current = await createAdapter(env, { currentUserId: launch.userId }).users.getCurrent();
      if (!current.ok) {
        throw toApiError(current.failure);
      }
      if (current.value.id !== launch.userId) {
        throw new ApiHttpError(401, 'UNAUTHENTICATED');
      }
      if (!current.value.isActive) {
        throw new ApiHttpError(403, 'FORBIDDEN');
      }

      const principal = sessionPrincipalSchema.parse({
        portalId: launch.portalId,
        userId: current.value.id,
        displayName: current.value.displayName,
        isBitrixAdmin: current.value.isAdmin,
      });
      const token = await createSessionToken(
        principal,
        env.SESSION_SIGNING_SECRET,
        now(),
        createSessionId(),
      );
      return { principal, cookie: serializeSessionCookie(token, 900) };
    },

    async read(cookieHeader: string | null | undefined): Promise<SessionPrincipal> {
      if (!hasLocalIdentityConfiguration(env)) {
        throw new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
      }

      const token = extractSessionCookie(cookieHeader ?? null);
      if (token === null) {
        throw new ApiHttpError(401, 'UNAUTHENTICATED');
      }

      try {
        const claims = await verifySessionToken(token, env.SESSION_SIGNING_SECRET, now());
        return sessionPrincipalSchema.parse({
          portalId: claims.portalId,
          userId: claims.userId,
          displayName: claims.displayName,
          isBitrixAdmin: claims.isBitrixAdmin,
        });
      } catch (error) {
        if (error instanceof InvalidSignedTokenError) {
          throw new ApiHttpError(401, 'UNAUTHENTICATED');
        }
        throw error;
      }
    },
  };
}
