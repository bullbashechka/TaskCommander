import { describe, expect, it } from 'vitest';

import { createMockBitrixAdapter } from '../src/integrations/bitrix/mock';
import { expectBitrixAdapterContract } from './bitrix-adapter-contract-suite';

describe('mock Bitrix adapter contract', () => {
  it('implements every server-side capability through the shared contract', async () => {
    await expectBitrixAdapterContract(createMockBitrixAdapter());
  });

  it('returns a known inactive current user so the identity layer can deny the launch safely', async () => {
    const result = await createMockBitrixAdapter({ currentUserId: '99' }).users.getCurrent();

    expect(result).toEqual({
      ok: true,
      value: {
        id: '99',
        displayName: 'Inactive employee',
        isActive: false,
        isAdmin: false,
        departmentIds: ['3'],
      },
    });
  });
});
