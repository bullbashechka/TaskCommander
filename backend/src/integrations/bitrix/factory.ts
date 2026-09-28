import type { RuntimeEnvironment } from '../../runtime/configuration';
import type { BitrixAdapter } from './contract';
import { createMockBitrixAdapter } from './mock';
import { createSupabaseMockTaskPersistence } from './mock/persistence';
import { enforceBitrixOriginPolicy } from './trusted-origin-adapter';

export class BitrixAdapterConfigurationError extends Error {}

export function isSupportedBitrixAdapterConfiguration(env: RuntimeEnvironment): boolean {
  return env.APP_ENV === 'local' && env.BITRIX_ADAPTER === 'mock';
}

export function createBitrixAdapter(
  env: RuntimeEnvironment,
  options: { currentUserId?: string; portalId?: string } = {},
): BitrixAdapter {
  if (isSupportedBitrixAdapterConfiguration(env)) {
    return enforceBitrixOriginPolicy(
      createMockBitrixAdapter({
        currentUserId: options.currentUserId,
        taskPersistence: options.portalId
          ? createSupabaseMockTaskPersistence(env, options.portalId)
          : undefined,
      }),
      env,
    );
  }

  throw new BitrixAdapterConfigurationError(
    'Bitrix adapter requires APP_ENV=local and BITRIX_ADAPTER=mock.',
  );
}
