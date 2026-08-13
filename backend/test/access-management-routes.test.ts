import { describe, expect, it, vi } from 'vitest';

import { accessEmployeeSearchResponseSchema, appPermissions } from '@task-commander/contracts';

import { createApi } from '../src/api';
import { resolveEffectiveAccess } from '../src/data/access';
import { createMockBitrixAdapter } from '../src/integrations/bitrix/mock';
import { createVerifiedTestPrincipal } from './verified-session-test-helper';

function administratorAccess(principal: Awaited<ReturnType<typeof createVerifiedTestPrincipal>>) {
  return resolveEffectiveAccess(principal, {
    findEffectiveAccessSettings: async () => ({
      accessActive: true,
      permissions: appPermissions,
      allowedFieldIds: [],
    }),
  });
}

describe('access management routes', () => {
  it('keeps an administrator row immutable and enriches employee access server-side', async () => {
    const principal = await createVerifiedTestPrincipal({
      userId: '1',
      displayName: 'Portal administrator',
      isBitrixAdmin: true,
    });
    const findSettings = vi.fn().mockResolvedValue([
      {
        user_id: '20',
        access_state: 'active',
        access_version: 4,
        permissions: ['app_access', 'manage_access'],
        field_set_id: null,
      },
    ]);
    const api = createApi({
      readEffectiveAccess: async () => administratorAccess(principal),
      readPrincipal: async () => principal,
      createBitrixAdapter: () => createMockBitrixAdapter({ currentUserId: '1' }),
      createAccessManagementRepository: () =>
        ({
          findSettings,
          resolveFieldSet: vi.fn().mockResolvedValue('123e4567-e89b-42d3-a456-426614174000'),
          findFieldSets: vi.fn().mockResolvedValue([
            {
              id: '123e4567-e89b-42d3-a456-426614174000',
              version: 1,
              member_count: 0,
              fingerprint: 'a'.repeat(64),
            },
          ]),
        }) as never,
    });

    const response = await api.request(
      'https://example.test/api/access-management/users?q=Department',
      { headers: { cookie: 'tc_session=test' } },
      { APP_ENV: 'local' },
    );

    expect(response.status).toBe(200);
    const body = accessEmployeeSearchResponseSchema.parse(await response.json());
    expect(body.employees[0]).toMatchObject({
      accessState: 'active',
      accessVersion: 4,
      permissionCount: 2,
    });
  });
});
