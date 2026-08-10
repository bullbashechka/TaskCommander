import { describe, it } from 'vitest';

import { createMockBitrixAdapter } from '../src/integrations/bitrix/mock';
import { expectBitrixAdapterContract } from './bitrix-adapter-contract-suite';

describe('mock Bitrix adapter contract', () => {
  it('implements every server-side capability through the shared contract', async () => {
    await expectBitrixAdapterContract(createMockBitrixAdapter());
  });
});
