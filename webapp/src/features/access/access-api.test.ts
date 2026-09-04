import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchCapabilities, fetchCommand, fetchFieldSetMembers, fetchPreflight } from './access-api';

const timestamp = '2026-08-13T10:00:00.000Z';
const fingerprint = 'a'.repeat(64);
const emptyScope = {
  kind: 'set' as const,
  fieldSetId: '123e4567-e89b-42d3-a456-426614174001',
  version: 1,
  count: 0,
  fingerprint,
};
const emptyDelta = {
  permissions: { added: [], removed: [] },
  fields: { before: emptyScope, after: emptyScope, addedCount: 0, removedCount: 0 },
};

function jsonResponse(value: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('access management API parsing', () => {
  it('preserves requested and automatic preflight deltas', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse({
      preflightId: '123e4567-e89b-42d3-a456-426614174010',
      draftId: '123e4567-e89b-42d3-a456-426614174011',
      draftRevision: 2,
      mode: 'grant',
      permissionCatalogVersion: 1,
      actorAccessVersion: 3,
      checkedAt: timestamp,
      expiresAt: '2026-08-13T10:10:00.000Z',
      ttlSeconds: 600,
      summary: { total: 1, ready: 1, excluded: 0, conflicts: 0, applied: 0, failed: 0, noChange: 0 },
      targets: [{
        employee: {
          userId: '42', displayName: 'Анна Смирнова', jobTitle: null,
          departmentName: null, avatarUrl: null, employmentState: 'active',
          accessState: 'revoked', accessVersion: null, permissionCount: 0,
          fieldScope: emptyScope, isManager: false, isBitrixAdmin: false,
        },
        state: 'ready', baseAccessVersion: null, checkedAccessVersion: null,
        requestedDelta: { ...emptyDelta, permissions: { added: ['run_bulk_operations'], removed: [] } },
        automaticDelta: { ...emptyDelta, permissions: { added: ['app_access', 'change_allowed_fields'], removed: [] } },
        issues: [],
      }],
      confirmation: {
        required: true, tokenRequired: true,
        acknowledgementText: 'Подтверждаю изменение доступа для 1 сотрудника.',
        recipientCount: 1, validForSeconds: 300,
      },
    })));

    const result = await fetchPreflight('123e4567-e89b-42d3-a456-426614174010');

    expect(result.targets[0]?.requestedDelta.permissions.added).toEqual(['run_bulk_operations']);
    expect(result.targets[0]?.automaticDelta.permissions.added).toEqual([
      'app_access',
      'change_allowed_fields',
    ]);
  });

  it('preserves terminal conflicts and notification status', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse({
      commandId: '123e4567-e89b-42d3-a456-426614174020',
      preflightId: '123e4567-e89b-42d3-a456-426614174010',
      state: 'partially_succeeded', mode: 'grant', acceptedAt: timestamp,
      startedAt: timestamp, completedAt: timestamp,
      summary: { total: 2, ready: 0, excluded: 0, conflicts: 1, applied: 1, failed: 0, noChange: 0 },
      targets: [
        { userId: '42', displayName: 'Анна Смирнова', state: 'applied', beforeAccessVersion: null, afterAccessVersion: 1, appliedDelta: emptyDelta, reasonCode: null, notificationState: 'failed' },
        { userId: '43', displayName: 'Иван Петров', state: 'conflict', beforeAccessVersion: 2, afterAccessVersion: null, appliedDelta: emptyDelta, reasonCode: 'TARGET_ACCESS_CHANGED', notificationState: 'not_required' },
      ],
    })));

    const result = await fetchCommand('123e4567-e89b-42d3-a456-426614174020');

    expect(result.state).toBe('partially_succeeded');
    expect(result.targets[0]?.notificationState).toBe('failed');
    expect(result.targets[1]?.state).toBe('conflict');
  });

  it('loads every page of a versioned field set', async () => {
    const request = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      return jsonResponse({
        reference: { ...emptyScope, kind: undefined, count: 2 },
        fieldIds: url.includes('cursor=1') ? ['deadline'] : ['title'],
        nextCursor: url.includes('cursor=1') ? null : '1',
      });
    });
    vi.stubGlobal('fetch', request);

    await expect(
      fetchFieldSetMembers({ fieldSetId: emptyScope.fieldSetId, version: 1, targetUserId: '42' }),
    ).resolves.toEqual(['title', 'deadline']);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not expose an upstream error message to the access interface', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                message: 'upstream token=secret-value',
                correlationId: 'TC-123e4567-e89b-42d3-a456-426614174000',
              },
            }),
            { status: 503, headers: { 'content-type': 'application/json' } },
          ),
        ),
      ),
    );

    await expect(fetchCapabilities()).rejects.toMatchObject({
      message: 'Не удалось безопасно получить данные доступа.',
      eventId: 'TC-123e4567-e89b-42d3-a456-426614174000',
    });
  });

  it('does not expose an invalid upstream correlation ID', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ error: { correlationId: 'token=secret-value' } }),
            { status: 503, headers: { 'content-type': 'application/json' } },
          ),
        ),
      ),
    );

    await expect(fetchCapabilities()).rejects.toMatchObject({ eventId: undefined });
  });

  it('normalizes a rejected fetch into a safe Russian transport error', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('Failed to fetch token=secret'))));

    await expect(fetchCapabilities()).rejects.toMatchObject({
      message: 'Не удалось подключиться к серверу. Повторите попытку позже.',
      status: 0,
    });
  });
});
