import {
  appPermissions,
  effectiveAccessResponseSchema,
  type Permission,
} from '@task-commander/contracts';
import { describe, expect, it } from 'vitest';

import type { VerifiedSessionPrincipal } from '../src/auth/session-service';
import {
  EffectiveAccessError,
  createDataAccessContext,
  getEffectiveAccessResponse,
  hasPermission,
  requireAuthorizedTaskFields,
  requireAllPermissions,
  requirePermission,
  requireReportAction,
  resolveEffectiveAccess,
  type EffectiveAccess,
  type EffectiveAccessSettingsReader,
} from '../src/data/access';
import { createMockBitrixAdapter } from '../src/integrations/bitrix/mock';
import { mockFixtureIds } from '../src/integrations/bitrix/mock/fixtures';
import { createMockScenario } from '../src/integrations/bitrix/mock/scenario';
import { createVerifiedTestPrincipal } from './verified-session-test-helper';

const operationId = '123e4567-e89b-42d3-a456-426614174010';
const defaultSettings = {
  accessActive: true,
  permissions: ['app_access', 'change_allowed_fields'],
  allowedFieldIds: ['title'],
};

function reader(settings: unknown | null): EffectiveAccessSettingsReader {
  return { findEffectiveAccessSettings: async () => settings };
}

async function resolve(
  overrides: Partial<{
    accessActive: boolean;
    permissions: Permission[];
    allowedFieldIds: string[];
  }> = {},
) {
  return resolveEffectiveAccess(
    await createVerifiedTestPrincipal(),
    reader({ ...defaultSettings, ...overrides }),
  );
}

describe('effective access', () => {
  it('recognizes every canonical application permission and fails closed when it is absent', async () => {
    for (const permission of appPermissions) {
      const access = await resolve({ permissions: [permission] });
      expect(() => requirePermission(access, permission)).not.toThrow();

      const absent = appPermissions.find((candidate) => candidate !== permission);
      if (absent) expect(() => requirePermission(access, absent)).toThrow(EffectiveAccessError);
    }
  });

  it('strictly rejects every malformed persisted settings row', async () => {
    const malformedRows: unknown[] = [
      null,
      { ...defaultSettings, accessActive: false },
      { ...defaultSettings, accessActive: 'false' },
      { ...defaultSettings, permissions: 'app_access' },
      { ...defaultSettings, permissions: ['app_access', 'app_access'] },
      { ...defaultSettings, permissions: ['unknown_permission'] },
      { ...defaultSettings, permissions: Array(11).fill('app_access') },
      { ...defaultSettings, allowedFieldIds: 'title' },
      { ...defaultSettings, allowedFieldIds: ['title', 'title'] },
      { ...defaultSettings, allowedFieldIds: [' title '] },
      { ...defaultSettings, allowedFieldIds: ['title', ' title '] },
      { ...defaultSettings, allowedFieldIds: [''] },
      { ...defaultSettings, allowedFieldIds: ['x'.repeat(129)] },
      { ...defaultSettings, allowedFieldIds: [1] },
      { ...defaultSettings, extra: true },
    ];

    for (const settings of malformedRows) {
      await expect(
        resolveEffectiveAccess(await createVerifiedTestPrincipal(), reader(settings)),
      ).rejects.toMatchObject({ kind: 'forbidden' });
    }
  });

  it('maps a settings reader failure to upstream unavailable', async () => {
    await expect(
      resolveEffectiveAccess(await createVerifiedTestPrincipal(), {
        findEffectiveAccessSettings: async () => {
          throw new Error('database detail');
        },
      }),
    ).rejects.toMatchObject({ kind: 'upstream_unavailable' });
  });

  it('gives a Bitrix administrator all permissions and fields without reading settings', async () => {
    let readerCalled = false;
    const administrator = await createVerifiedTestPrincipal({
      userId: '1',
      displayName: 'Administrator',
      isBitrixAdmin: true,
    });
    const access = await resolveEffectiveAccess(administrator, {
      findEffectiveAccessSettings: async () => {
        readerCalled = true;
        throw new Error('must not run');
      },
    });

    expect(readerCalled).toBe(false);
    expect(getEffectiveAccessResponse(access)).toEqual({
      permissions: appPermissions,
      fieldScope: { kind: 'all' },
    });

    const structuralAdministrator = {
      portalId: 'portal-1',
      userId: '1',
      displayName: 'Administrator',
      isBitrixAdmin: true,
    } as unknown as VerifiedSessionPrincipal;
    await expect(
      resolveEffectiveAccess(structuralAdministrator, reader(null)),
    ).rejects.toMatchObject({ kind: 'forbidden' });
  });

  it('rejects structurally forged effective access and data contexts at runtime', async () => {
    const forgedAccess = {
      principal: {
        portalId: 'portal-1',
        userId: '10',
        displayName: 'Operator',
        isBitrixAdmin: false,
      },
      permissions: appPermissions,
      fieldScope: { kind: 'all' },
    } as unknown as EffectiveAccess;

    expect(() => hasPermission(forgedAccess, 'app_access')).toThrow(EffectiveAccessError);
    expect(() => requirePermission(forgedAccess, 'app_access')).toThrow(EffectiveAccessError);
    expect(() => requireAllPermissions(forgedAccess, ['app_access'])).toThrow(EffectiveAccessError);
    expect(() => createDataAccessContext(forgedAccess)).toThrow(EffectiveAccessError);
    expect(() => getEffectiveAccessResponse(forgedAccess)).toThrow(EffectiveAccessError);

    const trusted = await resolve();
    const context = createDataAccessContext(trusted);
    expect(hasPermission(context, 'app_access')).toBe(true);
    expect(() => hasPermission({ ...trusted } as EffectiveAccess, 'app_access')).toThrow(
      EffectiveAccessError,
    );
    expect(() => hasPermission({ ...context } as typeof context, 'app_access')).toThrow(
      EffectiveAccessError,
    );

    const permissionWithoutAccess = await resolve({ permissions: ['view_own_reports'] });
    expect(() => createDataAccessContext(permissionWithoutAccess)).toThrow(EffectiveAccessError);
  });

  it('freezes and isolates every effective access and repository context value', async () => {
    const permissions: Permission[] = ['app_access', 'change_allowed_fields'];
    const allowedFieldIds = ['title'];
    const access = await resolveEffectiveAccess(
      await createVerifiedTestPrincipal(),
      reader({ accessActive: true, permissions, allowedFieldIds }),
    );
    const context = createDataAccessContext(access);

    permissions.push('manage_access');
    allowedFieldIds.push('status');
    expect(access.permissions).toEqual(['app_access', 'change_allowed_fields']);
    expect(access.fieldScope).toEqual({ kind: 'subset', fieldIds: ['title'] });
    expect(context.permissions).toEqual(['app_access', 'change_allowed_fields']);
    expect(Object.isFrozen(access)).toBe(true);
    expect(Object.isFrozen(access.principal)).toBe(true);
    expect(Object.isFrozen(access.permissions)).toBe(true);
    expect(Object.isFrozen(access.fieldScope)).toBe(true);
    if (access.fieldScope.kind === 'subset') {
      expect(Object.isFrozen(access.fieldScope.fieldIds)).toBe(true);
    }
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.permissions)).toBe(true);
    expect(Reflect.set(access.principal, 'portalId', 'forged-portal')).toBe(false);
    expect(Reflect.set(access.permissions, '0', 'manage_access')).toBe(false);
    if (access.fieldScope.kind === 'subset') {
      expect(Reflect.set(access.fieldScope.fieldIds, '0', 'status')).toBe(false);
    }
    expect(Reflect.set(context, 'actorId', '999')).toBe(false);
    expect(Reflect.set(context.permissions, '0', 'manage_access')).toBe(false);
  });

  it('requires both action and global visibility for every foreign report action', async () => {
    for (const action of ['retry_operations', 'restore_operations'] as const) {
      const own = await resolve({ permissions: ['app_access', action] });
      const ownLookups: unknown[] = [];
      await expect(
        requireReportAction(
          own,
          {
            findReportAuthorization: async (input) => {
              ownLookups.push(input);
              return { ownerId: '10' };
            },
          },
          { operationId, action },
        ),
      ).resolves.toBeUndefined();
      expect(ownLookups).toEqual([{ portalId: 'portal-1', operationId }]);

      for (const hasAction of [false, true]) {
        for (const hasAll of [false, true]) {
          const permissions = [
            'app_access' as const,
            ...(hasAction ? [action] : []),
            ...(hasAll ? (['view_all_reports'] as const) : []),
          ];
          const access = await resolve({ permissions });
          const result = requireReportAction(
            access,
            { findReportAuthorization: async () => ({ ownerId: '11' }) },
            { operationId, action },
          );
          if (hasAction && hasAll) await expect(result).resolves.toBeUndefined();
          else await expect(result).rejects.toMatchObject({ kind: 'forbidden' });
        }
      }
    }
  });

  it('requires app_access before report lookup even when the action permission exists', async () => {
    const access = await resolve({ permissions: ['retry_operations'] });
    let lookupCalled = false;
    await expect(
      requireReportAction(
        access,
        {
          findReportAuthorization: async () => {
            lookupCalled = true;
            return { ownerId: '10' };
          },
        },
        { operationId, action: 'retry_operations' },
      ),
    ).rejects.toMatchObject({ kind: 'forbidden' });
    expect(lookupCalled).toBe(false);
  });

  it('hides absent or cross-portal reports and maps report lookup failures safely', async () => {
    const access = await resolve({
      permissions: ['app_access', 'retry_operations', 'view_all_reports'],
    });
    await expect(
      requireReportAction(
        access,
        { findReportAuthorization: async () => null },
        { operationId, action: 'retry_operations' },
      ),
    ).rejects.toMatchObject({ kind: 'not_found' });
    await expect(
      requireReportAction(
        access,
        {
          findReportAuthorization: async (input) => {
            expect(input.portalId).toBe('portal-1');
            throw new Error('storage detail');
          },
        },
        { operationId, action: 'retry_operations' },
      ),
    ).rejects.toMatchObject({ kind: 'upstream_unavailable' });
  });

  it('deduplicates requested fields and rejects invalid, partial, or native-denied sets', async () => {
    const access = await resolve({
      permissions: ['app_access', 'change_allowed_fields'],
      allowedFieldIds: ['title', 'description'],
    });
    const adapter = createMockBitrixAdapter({ currentUserId: '10' });

    await expect(
      requireAuthorizedTaskFields(access, adapter, {
        taskId: mockFixtureIds.visibleTask,
        fieldIds: ['title', 'title'],
      }),
    ).resolves.toEqual(['title']);
    for (const fieldIds of [
      [],
      'title',
      [''],
      [1],
      ['title', 'status'],
    ]) {
      await expect(
        requireAuthorizedTaskFields(access, adapter, {
          taskId: mockFixtureIds.visibleTask,
          fieldIds,
        }),
      ).rejects.toMatchObject({ kind: 'forbidden' });
    }

    await expect(
      requireAuthorizedTaskFields(access, adapter, {
        taskId: mockFixtureIds.visibleTask,
        fieldIds: Array.from({ length: 257 }, () => 'title'),
      }),
    ).resolves.toEqual(['title']);

    const administrator = await resolveEffectiveAccess(
      await createVerifiedTestPrincipal({
        userId: '1',
        displayName: 'Administrator',
        isBitrixAdmin: true,
      }),
      reader(null),
    );
    const adminAdapter = createMockBitrixAdapter({ currentUserId: '1' });
    await expect(
      requireAuthorizedTaskFields(administrator, adminAdapter, {
        taskId: mockFixtureIds.visibleTask,
        fieldIds: ['missing_field'],
      }),
    ).rejects.toMatchObject({ kind: 'forbidden' });
    const nativeDeniedTask = adminAdapter.state.getMutableTask(mockFixtureIds.noEditTask);
    if (!nativeDeniedTask) throw new Error('Native-denied mock task is absent.');
    nativeDeniedTask.editableFieldIdsByUser = {};
    await expect(
      requireAuthorizedTaskFields(administrator, adminAdapter, {
        taskId: mockFixtureIds.noEditTask,
        fieldIds: ['title'],
      }),
    ).rejects.toMatchObject({ kind: 'forbidden' });

    await expect(
      requireAuthorizedTaskFields(access, createMockBitrixAdapter({ currentUserId: '1' }), {
        taskId: mockFixtureIds.visibleTask,
        fieldIds: ['title'],
      }),
    ).rejects.toMatchObject({ kind: 'forbidden' });

    const inactiveAdapter = createMockBitrixAdapter({ currentUserId: '10' });
    const currentOperator = inactiveAdapter.state.users.get('10');
    if (!currentOperator) throw new Error('Current mock operator is absent.');
    currentOperator.isActive = false;
    await expect(
      requireAuthorizedTaskFields(access, inactiveAdapter, {
        taskId: mockFixtureIds.visibleTask,
        fieldIds: ['title'],
      }),
    ).rejects.toMatchObject({ kind: 'forbidden' });
  });

  it('requires app_access before checking native field rights', async () => {
    const access = await resolve({ permissions: ['change_allowed_fields'] });
    let identityCalls = 0;
    const adapter = createMockBitrixAdapter({ currentUserId: '10' });
    const guardedAdapter = {
      ...adapter,
      users: {
        ...adapter.users,
        getCurrent: async () => {
          identityCalls += 1;
          return adapter.users.getCurrent();
        },
      },
    };
    await expect(
      requireAuthorizedTaskFields(access, guardedAdapter, {
        taskId: mockFixtureIds.visibleTask,
        fieldIds: ['title'],
      }),
    ).rejects.toMatchObject({ kind: 'forbidden' });
    expect(identityCalls).toBe(0);
  });

  it('maps Bitrix field authorization failures without exposing details', async () => {
    const access = await resolve({ permissions: ['app_access', 'change_allowed_fields'] });
    for (const testCase of [
      { failure: { kind: 'not_found_or_forbidden' } as const, expected: 'not_found' },
      { failure: { kind: 'permission_denied' } as const, expected: 'forbidden' },
      {
        failure: { kind: 'temporary_failure', reasonCode: 'private_detail' } as const,
        expected: 'upstream_unavailable',
      },
    ]) {
      const adapter = createMockBitrixAdapter({
        currentUserId: '10',
        scenario: createMockScenario([
          {
            method: 'tasks.readForChange',
            effect: { kind: 'return_failure', failure: testCase.failure },
          },
        ]),
      });
      await expect(
        requireAuthorizedTaskFields(access, adapter, {
          taskId: mockFixtureIds.visibleTask,
          fieldIds: ['title'],
        }),
      ).rejects.toMatchObject({ kind: testCase.expected });
    }

    const throwingAdapter = createMockBitrixAdapter({ currentUserId: '10' });
    await expect(
      requireAuthorizedTaskFields(
        access,
        {
          ...throwingAdapter,
          tasks: {
            ...throwingAdapter.tasks,
            readForChange: async () => {
              throw new Error('private task exception');
            },
          },
        },
        { taskId: mockFixtureIds.visibleTask, fieldIds: ['title'] },
      ),
    ).rejects.toMatchObject({ kind: 'upstream_unavailable' });
  });

  it('maps the per-attempt Bitrix identity recheck failures safely', async () => {
    const access = await resolve({ permissions: ['app_access', 'change_allowed_fields'] });
    for (const testCase of [
      { failure: { kind: 'not_found_or_forbidden' } as const, expected: 'not_found' },
      { failure: { kind: 'permission_denied' } as const, expected: 'forbidden' },
      {
        failure: { kind: 'temporary_failure', reasonCode: 'private_identity_detail' } as const,
        expected: 'upstream_unavailable',
      },
    ]) {
      const adapter = createMockBitrixAdapter({
        currentUserId: '10',
        scenario: createMockScenario([
          {
            method: 'users.getCurrent',
            effect: { kind: 'return_failure', failure: testCase.failure },
          },
        ]),
      });
      await expect(
        requireAuthorizedTaskFields(access, adapter, {
          taskId: mockFixtureIds.visibleTask,
          fieldIds: ['title'],
        }),
      ).rejects.toMatchObject({ kind: testCase.expected });
    }

    const throwingAdapter = createMockBitrixAdapter({ currentUserId: '10' });
    await expect(
      requireAuthorizedTaskFields(
        access,
        {
          ...throwingAdapter,
          users: {
            ...throwingAdapter.users,
            getCurrent: async () => {
              throw new Error('private identity exception');
            },
          },
        },
        { taskId: mockFixtureIds.visibleTask, fieldIds: ['title'] },
      ),
    ).rejects.toMatchObject({ kind: 'upstream_unavailable' });
  });

  it('produces a strict public response from trusted access only', async () => {
    const access = await resolve();
    expect(effectiveAccessResponseSchema.parse(getEffectiveAccessResponse(access))).toEqual({
      permissions: ['app_access', 'change_allowed_fields'],
      fieldScope: { kind: 'subset', fieldIds: ['title'] },
    });
  });
});
