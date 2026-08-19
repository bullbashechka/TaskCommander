import { describe, expect, it } from 'vitest';

import {
  appPermissions,
  effectiveAccessResponseSchema,
  fieldScopeSchema,
  permissionSchema,
} from './access';

describe('access contracts', () => {
  it('defines exactly the ten canonical Task Commander permissions', () => {
    expect(appPermissions).toEqual([
      'app_access',
      'run_bulk_operations',
      'change_allowed_fields',
      'retry_operations',
      'restore_operations',
      'view_own_reports',
      'view_all_reports',
      'export_reports',
      'view_audit',
      'manage_access',
    ]);
    expect(new Set(appPermissions).size).toBe(10);
    expect(Object.isFrozen(appPermissions)).toBe(true);
    expect(Reflect.set(appPermissions, '0', 'forged_permission')).toBe(false);
    expect(appPermissions[0]).toBe('app_access');
    expect(permissionSchema.safeParse('unknown_permission').success).toBe(false);
  });

  it('accepts strict all and subset field scopes only', () => {
    expect(fieldScopeSchema.parse({ kind: 'all' })).toEqual({ kind: 'all' });
    expect(fieldScopeSchema.parse({ kind: 'subset', fieldIds: [] })).toEqual({
      kind: 'subset',
      fieldIds: [],
    });
    expect(fieldScopeSchema.safeParse({ kind: 'all', fieldIds: [] }).success).toBe(false);
    expect(
      fieldScopeSchema.safeParse({ kind: 'subset', fieldIds: ['title'], extra: true }).success,
    ).toBe(false);
  });

  it('rejects duplicates without imposing an assignment-size cap', () => {
    expect(
      effectiveAccessResponseSchema.safeParse({
        permissions: ['app_access', 'app_access'],
        fieldScope: { kind: 'subset', fieldIds: [] },
      }).success,
    ).toBe(false);
    expect(
      effectiveAccessResponseSchema.safeParse({
        permissions: [...appPermissions, 'app_access'],
        fieldScope: { kind: 'all' },
      }).success,
    ).toBe(false);
    expect(
      fieldScopeSchema.safeParse({
        kind: 'subset',
        fieldIds: Array.from({ length: 257 }, (_, index) => `field_${index}`),
      }).success,
    ).toBe(true);
    expect(
      fieldScopeSchema.safeParse({ kind: 'subset', fieldIds: ['title', 'title'] }).success,
    ).toBe(false);
  });

  it('keeps the effective-access response strict', () => {
    expect(
      effectiveAccessResponseSchema.safeParse({
        permissions: ['app_access'],
        fieldScope: { kind: 'all' },
        principal: { userId: '10' },
      }).success,
    ).toBe(false);
  });
});
