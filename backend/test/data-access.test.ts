import { describe, expect, it } from 'vitest';

import {
  createDataAccessContext,
  createSystemConsumerContext,
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

  it('returns null when the current user has no operation draft', async () => {
    const query = {
      select() {
        return this;
      },
      eq() {
        return this;
      },
      gt() {
        return this;
      },
      maybeSingle: async () => ({ data: null, error: null }),
    };
    const repositories = new TaskCommanderRepositories({ from: () => query } as never, [
      'https://portal.bitrix24.ru',
    ]);

    await expect(
      repositories.getCurrentDraft(await contextWith(['app_access'])),
    ).resolves.toBeNull();
  });

  it('restores safe defaults for a legacy draft with null snapshots', async () => {
    const query = {
      select() {
        return this;
      },
      eq() {
        return this;
      },
      gt() {
        return this;
      },
      maybeSingle: async () => ({
        data: {
          id: '123e4567-e89b-42d3-a456-426614174000',
          portal_id: 'test-portal',
          owner_id: '1001',
          revision: 1,
          status: 'preparing',
          filter_snapshot: null,
          sort_snapshot: null,
          selected_task_ids: ['42'],
          changes: [{ fieldId: 'title', kind: 'text', action: 'set', value: 'Legacy' }],
          preflight_snapshot: null,
          created_at: '2026-09-04T10:00:00.000Z',
          updated_at: '2026-09-04T10:00:00.000Z',
          expires_at: '2026-09-05T10:00:00.000Z',
        },
        error: null,
      }),
    };
    const repositories = new TaskCommanderRepositories({ from: () => query } as never, [
      'https://portal.bitrix24.ru',
    ]);

    await expect(
      repositories.getCurrentDraft(await contextWith(['app_access'])),
    ).resolves.toMatchObject({
      filters: [],
      sort: { fieldId: 'deadline', direction: 'asc' },
    });
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
    const repositories = new TaskCommanderRepositories(client as never, [
      'https://portal.bitrix24.ru',
    ]);
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

  it('keeps user mutations and worker transitions on distinct capabilities', async () => {
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
    const repositories = new TaskCommanderRepositories(client as never, [
      'https://portal.bitrix24.ru',
    ]);
    const user = await contextWith(['app_access', 'run_bulk_operations']);
    const system = createSystemConsumerContext('test-portal', '1001');

    await expect(repositories.recordTaskResult(user as never, {} as never)).rejects.toMatchObject({
      code: 'UNAVAILABLE_RECORD',
    });
    await expect(repositories.startOperation(user as never, {} as never)).rejects.toMatchObject({
      code: 'UNAVAILABLE_RECORD',
    });
    await expect(
      repositories.createSavedFilter(system as never, { name: 'System', filterPayload: {} }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE_RECORD' });
    expect(clientAccesses).toBe(0);
  });

  it('rejects foreign task URLs before any storage call', async () => {
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
    const repositories = new TaskCommanderRepositories(client as never, [
      'https://portal.bitrix24.ru',
    ]);
    const user = await contextWith(['app_access', 'run_bulk_operations']);
    const system = createSystemConsumerContext('test-portal', '1001');

    await expect(
      repositories.createOperation(user, {
        type: 'bulk_change',
        initiatorDisplayName: 'Test user',
        sourceOperationId: null,
        idempotencyKey: crypto.randomUUID(),
        filterSnapshot: null,
        selectedTaskIds: ['42'],
        changes: [],
        preflightSnapshot: {},
        summary: { selected: 1, eligible: 0, excluded: 1, unchanged: 0 },
        correlationId: 'TC-123e4567-e89b-42d3-a456-426614174000',
        initialResults: [
          {
            taskId: '42',
            title: 'Foreign task',
            taskUrl: 'https://attacker.example/task/42',
            outcome: 'excluded_by_preflight',
            requestedFieldIds: [],
            reasonCode: 'UPSTREAM_FAILURE',
            reasonMessage: null,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'INTEGRITY' });
    await expect(
      repositories.recordTaskResult(system, {
        operationId: crypto.randomUUID(),
        launchAttempt: 1,
        taskId: '42',
        title: 'Foreign task',
        taskUrl: 'https://attacker.example/task/42',
        outcome: 'success',
        requestedFieldIds: [],
        appliedFieldIds: [],
        failedFieldIds: [],
        reasonCode: null,
        reasonMessage: null,
        correlationId: null,
        canRetry: false,
      }),
    ).rejects.toMatchObject({ code: 'INTEGRITY' });
    expect(clientAccesses).toBe(0);
  });

  it('classifies stale conditional writes as conflicts', () => {
    expect(toDataAccessError({ code: 'P0001', message: 'TC_DRAFT_REVISION_CONFLICT' })).toEqual(
      expect.objectContaining({ code: 'CONFLICT', retryable: false }),
    );
    expect(toDataAccessError({ code: 'P0001', message: 'TC_SAVED_FILTER_LIMIT' })).toEqual(
      expect.objectContaining({ code: 'SAVED_FILTER_LIMIT', retryable: false }),
    );
    expect(
      toDataAccessError({
        code: '23505',
        message: 'duplicate key violates saved_filter_owner_name_key',
      }),
    ).toEqual(expect.objectContaining({ code: 'SAVED_FILTER_NAME_TAKEN', retryable: false }));
  });

  it('rejects a local Supabase endpoint outside the allowlist', () => {
    expect(() =>
      createServerSupabaseClient({
        APP_ENV: 'local',
        BITRIX_ADAPTER: 'mock',
        SUPABASE_URL: 'https://unexpected.supabase.test',
        SUPABASE_SERVICE_ROLE_KEY: 'test-only-key',
        SUPABASE_ALLOWED_ORIGINS: 'https://approved.supabase.test',
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
        SUPABASE_ALLOWED_ORIGINS: 'https://dev.supabase.test',
      }),
    ).toThrow(DataAccessError);
  });

  it.each([
    'https://user:password@approved.supabase.test',
    'https://approved.supabase.test/unexpected',
    'https://approved.supabase.test?token=unexpected',
    'https://approved.supabase.test#unexpected',
    'https://approved.supabase.test:8443',
  ])('rejects hostile Supabase URLs before creating a client: %s', (url) => {
    const requestFetch = () => {
      throw new Error('Network access must not happen.');
    };
    expect(() =>
      createServerSupabaseClient(
        {
          APP_ENV: 'local',
          BITRIX_ADAPTER: 'mock',
          SUPABASE_URL: url,
          SUPABASE_SERVICE_ROLE_KEY: 'test-only-key',
          SUPABASE_ALLOWED_ORIGINS: 'https://approved.supabase.test',
        },
        requestFetch,
      ),
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
