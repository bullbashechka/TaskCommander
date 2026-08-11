import type { RuntimeEnvironment } from '../../runtime/configuration';
import type { BitrixAdapter } from './contract';
import { createMockBitrixAdapter } from './mock';

export class BitrixAdapterConfigurationError extends Error {}

export function isSupportedBitrixAdapterConfiguration(env: RuntimeEnvironment): boolean {
  return env.APP_ENV === 'local' && env.BITRIX_ADAPTER === 'mock';
}

export function createBitrixAdapter(env: RuntimeEnvironment): BitrixAdapter {
  if (isSupportedBitrixAdapterConfiguration(env)) {
    return createMockBitrixAdapter();
  }

  throw new BitrixAdapterConfigurationError(
    'Bitrix adapter requires APP_ENV=local and BITRIX_ADAPTER=mock.',
  );
}
