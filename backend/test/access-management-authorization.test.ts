import { describe, expect, it } from 'vitest';

import { authorizeAccessManager } from '../src/access-management/authorization';
import { resolveEffectiveAccess } from '../src/data/access';
import { createMockBitrixAdapter } from '../src/integrations/bitrix/mock';
import { createVerifiedTestPrincipal } from './verified-session-test-helper';

describe('access manager authorization', () => {
  it('requires both manage_access and live Bitrix leadership for a non-admin', async () => {
    const principal = await createVerifiedTestPrincipal({ userId: '20' });
    const access = await resolveEffectiveAccess(principal, {
      findEffectiveAccessSettings: async () => ({
        accessActive: true,
        permissions: ['app_access', 'manage_access'],
        allowedFieldIds: ['title'],
      }),
    });

    await expect(
      authorizeAccessManager({
        principal,
        access,
        adapter: createMockBitrixAdapter({ currentUserId: '20' }),
      }),
    ).resolves.toMatchObject({ isAdministrator: false });
  });

  it('rejects stale administrator authority', async () => {
    const principal = await createVerifiedTestPrincipal({
      userId: '10',
      isBitrixAdmin: true,
    });
    const access = await resolveEffectiveAccess(principal, {
      findEffectiveAccessSettings: async () => null,
    });

    await expect(
      authorizeAccessManager({
        principal,
        access,
        adapter: createMockBitrixAdapter({ currentUserId: '10' }),
      }),
    ).rejects.toMatchObject({ kind: 'forbidden' });
  });
});
