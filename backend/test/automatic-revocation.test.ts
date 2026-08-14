import { describe, expect, it, vi } from 'vitest';

import {
  runAutomaticAccessReconciliation,
  verifyCurrentSessionPrincipal,
} from '../src/access-management/automatic-revocation';
import { createApi } from '../src/api';
import { createMockBitrixAdapter } from '../src/integrations/bitrix/mock';
import { createMockScenario } from '../src/integrations/bitrix/mock/scenario';
import { createVerifiedTestPrincipal } from './verified-session-test-helper';

const environment = {
  APP_ENV: 'local',
  BITRIX_ADAPTER: 'mock',
  MOCK_LAUNCH_SIGNING_SECRET: 'test-mock-launch-signing-secret-0001',
  SESSION_SIGNING_SECRET: 'test-session-signing-secret-0000001',
};

describe('automatic access revocation identity boundary', () => {
  it('denies an inactive signed-session user and attempts one durable automatic revoke', async () => {
    const principal = await createVerifiedTestPrincipal({ userId: '10' });
    const adapter = createMockBitrixAdapter({
      currentUserId: '10',
      scenario: createMockScenario([
        {
          method: 'users.getCurrent',
          effect: { kind: 'deactivate_user', userId: '10' },
        },
      ]),
    });
    const applyAutomaticAccessReconciliation = vi.fn().mockResolvedValue({ disposition: 'applied' });

    await expect(
      verifyCurrentSessionPrincipal({
        env: environment,
        principal,
        adapter,
        repository: { applyAutomaticAccessReconciliation } as never,
        correlationId: 'TC-123e4567-e89b-42d3-a456-426614174000',
      }),
    ).rejects.toMatchObject({ kind: 'revoked' });
    expect(applyAutomaticAccessReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({
        employmentState: 'inactive',
        source: 'request',
        userId: '10',
      }),
    );
  });

  it('uses the current Bitrix administrator fact rather than the stale signed cookie claim', async () => {
    const administrator = await createVerifiedTestPrincipal({
      userId: '1',
      displayName: 'Portal administrator',
      isBitrixAdmin: true,
    });
    const adapter = createMockBitrixAdapter({ currentUserId: '1' });
    const user = adapter.state.users.get('1');
    if (user) user.isAdmin = false;

    const current = await verifyCurrentSessionPrincipal({
      env: environment,
      principal: administrator,
      adapter,
      correlationId: 'TC-123e4567-e89b-42d3-a456-426614174001',
    });
    expect(current.isBitrixAdmin).toBe(false);
  });

  it('does not turn an upstream identity failure into a revocation', async () => {
    const principal = await createVerifiedTestPrincipal({ userId: '10' });
    const adapter = createMockBitrixAdapter({
      currentUserId: '10',
      scenario: createMockScenario([
        {
          method: 'users.getCurrent',
          effect: { kind: 'return_failure', failure: { kind: 'temporary_failure', reasonCode: 'DOWN' } },
        },
      ]),
    });

    await expect(
      verifyCurrentSessionPrincipal({
        env: environment,
        principal,
        adapter,
        correlationId: 'TC-123e4567-e89b-42d3-a456-426614174002',
      }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('returns a distinct API code when Bitrix24 confirms that the session user is inactive', async () => {
    const principal = await createVerifiedTestPrincipal({ userId: '10' });
    const adapter = createMockBitrixAdapter({
      currentUserId: '10',
      scenario: createMockScenario([
        {
          method: 'users.getCurrent',
          effect: { kind: 'deactivate_user', userId: '10' },
        },
      ]),
    });
    const api = createApi({
      readPrincipal: async () => principal,
      createBitrixAdapter: () => adapter,
      createAccessManagementRepository: () =>
        ({
          applyAutomaticAccessReconciliation: vi.fn().mockResolvedValue({ disposition: 'applied' }),
        }) as never,
    });

    const response = await api.request('https://example.test/api/access', undefined, environment);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'ACCESS_REVOKED' } });
  });

  it('uses one portal directory snapshot and records each claimed background subject', async () => {
    const adapter = createMockBitrixAdapter({ currentUserId: '11' });
    const applyAutomaticAccessReconciliation = vi.fn().mockResolvedValue({ disposition: 'applied' });
    const repository = {
      claimAutomaticAccessReconciliationJobs: vi.fn().mockResolvedValue([
        { portalId: 'portal-1', userId: '11' },
        { portalId: 'portal-1', userId: '10' },
      ]),
      applyAutomaticAccessReconciliation,
      recordAutomaticAccessReconciliationUnknown: vi.fn(),
    };

    await expect(
      runAutomaticAccessReconciliation(environment, {
        repository: repository as never,
        createAdapter: () => adapter,
        createLeaseToken: () => '123e4567-e89b-42d3-a456-426614174099',
      }),
    ).resolves.toEqual({ checked: 2, changed: 2, unknown: 0 });
    expect(applyAutomaticAccessReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({ userId: '11', employmentState: 'active', isManager: true }),
    );
    expect(applyAutomaticAccessReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({ userId: '10', employmentState: 'active', isManager: false }),
    );
  });

  it('keeps every subject unchanged when a background status snapshot is incomplete', async () => {
    const adapter = createMockBitrixAdapter({ currentUserId: '11' });
    adapter.users.getAccessStatuses = vi.fn().mockResolvedValue({ ok: true, value: [] });
    const repository = {
      claimAutomaticAccessReconciliationJobs: vi.fn().mockResolvedValue([
        { portalId: 'portal-1', userId: '11' },
        { portalId: 'portal-1', userId: '10' },
      ]),
      applyAutomaticAccessReconciliation: vi.fn(),
      recordAutomaticAccessReconciliationUnknown: vi.fn(),
    };

    await expect(
      runAutomaticAccessReconciliation(environment, {
        repository: repository as never,
        createAdapter: () => adapter,
        createLeaseToken: () => '123e4567-e89b-42d3-a456-426614174098',
      }),
    ).resolves.toEqual({ checked: 0, changed: 0, unknown: 2 });
    expect(repository.applyAutomaticAccessReconciliation).not.toHaveBeenCalled();
    expect(repository.recordAutomaticAccessReconciliationUnknown).toHaveBeenCalledTimes(2);
  });
});
