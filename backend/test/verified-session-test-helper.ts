import { sessionPrincipalSchema, type SessionPrincipal } from '@task-commander/contracts';

import { createSessionService, type VerifiedSessionPrincipal } from '../src/auth/session-service';
import { createSessionToken } from '../src/auth/signed-token';

const sessionSecret = 'test-verified-session-secret-00000001';
const now = new Date('2026-08-12T10:00:00.000Z');
const environment = {
  APP_ENV: 'local',
  BITRIX_ADAPTER: 'mock',
  MOCK_LAUNCH_SIGNING_SECRET: 'test-verified-launch-secret-00000001',
  SESSION_SIGNING_SECRET: sessionSecret,
};

export async function createVerifiedTestPrincipal(
  input: Partial<SessionPrincipal> = {},
): Promise<VerifiedSessionPrincipal> {
  const principal = sessionPrincipalSchema.parse({
    portalId: 'portal-1',
    userId: '10',
    displayName: 'Operator',
    isBitrixAdmin: false,
    ...input,
  });
  const token = await createSessionToken(
    principal,
    sessionSecret,
    now,
    '123e4567-e89b-42d3-a456-426614174099',
  );
  return createSessionService(environment, { now: () => now }).read(`tc_session=${token}`);
}
