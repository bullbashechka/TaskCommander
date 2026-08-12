import { describe, expect, it } from 'vitest';

import {
  createDataAccessContext,
  requirePermission,
  resolveEffectiveAccess,
} from '../src/data/access';
import { createServerSupabaseClient } from '../src/data/client';
import { createNextCursor, resolvePageRequest } from '../src/data/cursor';
import { DataAccessError, toDataAccessError } from '../src/data/errors';
import { getReportVisibility, TaskCommanderRepositories } from '../src/data/repositories';
import { createVerifiedTestPrincipal } from './verified-session-test-helper';

async function contextWith(permissions: string[]) {
  return createDataAccessContext(
    await resolveEffectiveAccess(
      await createVerifiedTestPrincipal({
        portalId: 'test-portal',
        userId: '1001',
        displayName: 'Test user',
        isBitrixAdmin: false,
      }),
      {
        findEffectiveAccessSettings: async () => ({
          accessActive: true,
          permissions,
          allowedFieldIds: [],
        }),
      },
    ),
  );
}

describe('data access boundaries', () => {
  it('rejects a malformed or cross-scope cursor', () => {
    expect(() =>
      resolvePageRequest({ cursor: 'not-a-cursor' }, 'operation-history', 'own:a'),
    ).toThrow(DataAccessError);

    const cursor = createNextCursor(
      'operation-history',
      'own:a',
      '2026-08-11T00:00:00.000Z',
      '2026-08-10T00:00:00.000Z',
      '00000000-0000-4000-8000-000000000001',
    );
    expect(() => resolvePageRequest({ cursor }, 'operation-history', 'own:b')).toThrow(
      DataAccessError,
    );
  });

  it('keeps the cursor time boundary and tie-breaker stable', () => {
    const cursor = createNextCursor(
      'audit-events',
      'audit:test-portal:1001',
      '2026-08-11T00:00:00.000Z',
      '2026-08-10T00:00:00.000Z',
      '00000000-0000-4000-8000-000000000001',
    );

    expect(
      resolvePageRequest({ cursor, limit: 50 }, 'audit-events', 'audit:test-portal:1001'),
    ).toEqual({
      asOf: '2026-08-11T00:00:00.000Z',
      before: {
        timestamp: '2026-08-10T00:00:00.000Z',
        id: '00000000-0000-4000-8000-000000000001',
      },
      limit: 50,
    });
  });

  it('fails closed when a permission is absent', async () => {
    const context = await contextWith(['app_access', 'view_own_reports']);
    expect(() => requirePermission(context, 'view_audit')).toThrow();
  });

  it('requires explicit own or all report visibility', async () => {
    expect(getReportVisibility(await contextWith(['app_access', 'view_own_reports']))).toBe('own');
    expect(getReportVisibility(await contextWith(['app_access', 'view_all_reports']))).toBe('all');
    const noVisibility = await contextWith(['app_access']);
    expect(() => getReportVisibility(noVisibility)).toThrow(DataAccessError);
    expect(() => getReportVisibility({ ...noVisibility } as typeof noVisibility)).toThrow(
      DataAccessError,
    );
  });

  it('rejects forged repository contexts before representative read or write client access', async () => {
    let clientAccesses = 0;
    const client = new Proxy(
      {},
      {
        get: () => {
          clientAccesses += 1;
          throw new Error('The storage client must not be reached.');
        },
      },
    );
    const repositories = new TaskCommanderRepositories(client as never);
    const trusted = await contextWith(['app_access']);
    const forged = { ...trusted } as typeof trusted;

    await expect(repositories.listSavedFilters(forged)).rejects.toMatchObject({
      code: 'UNAVAILABLE_RECORD',
    });
    await expect(
      repositories.createSavedFilter(forged, { name: 'Forged', filterPayload: {} }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE_RECORD' });
    expect(clientAccesses).toBe(0);
  });

  it('classifies stale conditional writes as conflicts', () => {
    expect(toDataAccessError({ code: 'P0001', message: 'TC_DRAFT_REVISION_CONFLICT' })).toEqual(
      expect.objectContaining({ code: 'CONFLICT', retryable: false }),
    );
  });

  it('rejects a local Supabase endpoint outside the allowlist', () => {
    expect(() =>
      createServerSupabaseClient({
        APP_ENV: 'local',
        BITRIX_ADAPTER: 'mock',
        SUPABASE_URL: 'https://unexpected.supabase.test',
        SUPABASE_SERVICE_ROLE_KEY: 'test-only-key',
        LOCAL_SUPABASE_ALLOWED_HOSTS: 'approved.supabase.test',
      }),
    ).toThrow(DataAccessError);
  });

  it('rejects an HTTP Supabase endpoint even when allowlisted', () => {
    expect(() =>
      createServerSupabaseClient({
        APP_ENV: 'local',
        BITRIX_ADAPTER: 'mock',
        SUPABASE_URL: 'http://dev.supabase.test',
        SUPABASE_SERVICE_ROLE_KEY: 'test-only-key',
        LOCAL_SUPABASE_ALLOWED_HOSTS: 'dev.supabase.test',
      }),
    ).toThrow(DataAccessError);
  });

  it('maps storage and transport failures without exposing source details', () => {
    expect(toDataAccessError({ code: '23505', message: 'sensitive database detail' })).toEqual(
      expect.objectContaining({ code: 'CONFLICT', retryable: false }),
    );
    expect(toDataAccessError(new Error('connection failed'))).toEqual(
      expect.objectContaining({ code: 'UNAVAILABLE', retryable: true }),
    );
  });
});
