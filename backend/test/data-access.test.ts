import { describe, expect, it } from 'vitest';

import { createDataAccessContext, requirePermission } from '../src/data/access';
import { createServerSupabaseClient } from '../src/data/client';
import { createNextCursor, resolvePageRequest } from '../src/data/cursor';
import { DataAccessError, toDataAccessError } from '../src/data/errors';

const context = createDataAccessContext({
  portalId: 'test-portal',
  actorId: '1001',
  permissions: ['view_own_reports'],
});

describe('data access boundaries', () => {
  it('rejects a malformed or cross-scope cursor', () => {
    expect(() => resolvePageRequest({ cursor: 'not-a-cursor' }, 'operation-history', 'own:a')).toThrow(
      DataAccessError,
    );

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

  it('fails closed when a permission is absent', () => {
    expect(() => requirePermission(context, 'view_audit')).toThrow(DataAccessError);
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
