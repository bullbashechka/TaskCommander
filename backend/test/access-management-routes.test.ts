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
      accessVersion: 1,
    }),
  });
}

describe('access management routes', () => {
  it('applies the client limit before identity and external side effects', async () => {
    const principal = await createVerifiedTestPrincipal({
      portalId: 'tenant-rate-limit',
      userId: '1',
      displayName: 'Portal administrator',
      isBitrixAdmin: true,
    });
    const limit = vi.fn().mockResolvedValue({ success: false });
    const createRepository = vi.fn();
    const readPrincipal = vi.fn().mockResolvedValue(principal);
    const api = createApi({
      readEffectiveAccess: async () => administratorAccess(principal),
      readPrincipal,
      createBitrixAdapter: () => createMockBitrixAdapter({ currentUserId: '1' }),
      createAccessManagementRepository: createRepository,
    });

    const response = await api.request(
      'https://example.test/api/access-management/users',
      { headers: { cookie: 'tc_session=test', 'cf-connecting-ip': '192.0.2.10' } },
      {
        APP_ENV: 'local',
        APP_ORIGIN: 'https://example.test',
        ACCESS_FANOUT_RATE_LIMITER: { limit },
      },
    );

    expect(response.status).toBe(429);
    expect(limit).toHaveBeenCalledWith({
      key: 'client:192.0.2.10:access-management:users-search',
    });
    expect(readPrincipal).not.toHaveBeenCalled();
    expect(createRepository).not.toHaveBeenCalled();
  });

  it('applies a second limit isolated by portal, actor and action', async () => {
    const principal = await createVerifiedTestPrincipal({
      portalId: 'tenant-rate-limit',
      userId: '1',
      displayName: 'Portal administrator',
      isBitrixAdmin: true,
    });
    const limit = vi
      .fn()
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false });
    const api = createApi({
      readEffectiveAccess: async () => administratorAccess(principal),
      readPrincipal: async () => principal,
      createBitrixAdapter: () => createMockBitrixAdapter({ currentUserId: '1' }),
      createAccessManagementRepository: vi.fn(),
    });

    const response = await api.request(
      'https://example.test/api/access-management/users',
      { headers: { cookie: 'tc_session=test', 'cf-connecting-ip': '192.0.2.10' } },
      {
        APP_ENV: 'local',
        APP_ORIGIN: 'https://example.test',
        ACCESS_FANOUT_RATE_LIMITER: { limit },
      },
    );

    expect(response.status).toBe(429);
    expect(limit).toHaveBeenNthCalledWith(2, { key: 'tenant-rate-limit:1:users-search' });
  });

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
          consumeFilteredSearchLimit: vi.fn().mockResolvedValue(undefined),
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
      {
        APP_ENV: 'local',
        APP_ORIGIN: 'https://example.test',
        BITRIX_PORTAL_ORIGIN: 'https://portal.bitrix24.ru',
        ACCESS_FANOUT_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
      },
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
