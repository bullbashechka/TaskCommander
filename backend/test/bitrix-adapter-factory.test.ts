import { describe, expect, it } from 'vitest';

import {
  BitrixAdapterConfigurationError,
  createBitrixAdapter,
  isSupportedBitrixAdapterConfiguration,
} from '../src/integrations/bitrix/factory';
import { expectBitrixAdapterContract } from './bitrix-adapter-contract-suite';

describe('Bitrix adapter factory', () => {
  it('composes a mock adapter only for the explicit local mock configuration', async () => {
    const adapter = createBitrixAdapter({ APP_ENV: 'local', BITRIX_ADAPTER: 'mock' });

    await expectBitrixAdapterContract(adapter);
  });

  it('does not treat a mock adapter outside local runtime as configured', () => {
    expect(
      isSupportedBitrixAdapterConfiguration({ APP_ENV: 'production', BITRIX_ADAPTER: 'mock' }),
    ).toBe(false);
    expect(() => createBitrixAdapter({ APP_ENV: 'production', BITRIX_ADAPTER: 'mock' })).toThrow(
      BitrixAdapterConfigurationError,
    );
  });
});
