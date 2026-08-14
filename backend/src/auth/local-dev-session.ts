import { z } from 'zod';

import { ApiHttpError } from '../http/errors';
import { hasLocalIdentityConfiguration, type RuntimeEnvironment } from '../runtime/configuration';
import { createMockLaunchContext } from './signed-token';
import { createSessionService, type CreatedSession } from './session-service';

export const localDevUserIds = ['1', '10'] as const;

export const createLocalDevSessionRequestSchema = z
  .object({
    userId: z.enum(localDevUserIds),
  })
  .strict();

const localDevPortalId = 'local-demo';

/** Creates a local-only session without exposing a mock launch context to the client. */
export async function createLocalDevSession(
  env: RuntimeEnvironment,
  userId: (typeof localDevUserIds)[number],
): Promise<CreatedSession> {
  if (!hasLocalIdentityConfiguration(env) || env.MOCK_LAUNCH_SIGNING_SECRET === undefined) {
    throw new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
  }

  const launchContext = await createMockLaunchContext(
    {
      portalId: localDevPortalId,
      userId,
    },
    env.MOCK_LAUNCH_SIGNING_SECRET,
  );
  return createSessionService(env).create(launchContext);
}
