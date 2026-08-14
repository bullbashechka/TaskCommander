import { describe, expect, it } from 'vitest';

import type { AppAccessSnapshot } from './app-context';
import { canStartBulkChange, canVisitRoute, hasEmptyFieldScope } from './access-policy';
import { createNavigationModel } from './navigation-model';

function snapshot(
  permissions: AppAccessSnapshot['access']['permissions'],
  overrides: Partial<AppAccessSnapshot> = {},
): AppAccessSnapshot {
  return {
    principal: {
      portalId: 'portal.test',
      userId: '42',
      displayName: 'Тестовый пользователь',
      isBitrixAdmin: false,
    },
    access: { permissions, fieldScope: { kind: 'all' } },
    accessManagement: 'denied',
    generation: 0,
    canMutate: true,
    ...overrides,
  };
}

describe('access policy', () => {
  it('keeps tasks available for an app user without permission to launch a change', () => {
    const app = snapshot(['app_access'], {
      access: { permissions: ['app_access'], fieldScope: { kind: 'subset', fieldIds: [] } },
    });

    expect(canVisitRoute(app, 'tasks')).toBe(true);
    expect(canStartBulkChange(app)).toBe(false);
    expect(hasEmptyFieldScope(app)).toBe(true);
    expect(createNavigationModel(app).taskLinks.map((item) => item.route)).toEqual(['tasks']);
  });

  it('maps reporting and operation permissions without treating export as page access', () => {
    expect(canVisitRoute(snapshot(['view_own_reports']), 'reports')).toBe(true);
    expect(canVisitRoute(snapshot(['view_own_reports']), 'operations')).toBe(true);
    expect(canVisitRoute(snapshot(['export_reports']), 'reports')).toBe(false);
    expect(canVisitRoute(snapshot(['run_bulk_operations']), 'operations')).toBe(true);
  });

  it('shows access management only after a dedicated current verification', () => {
    const unconfirmed = snapshot(['app_access', 'manage_access']);
    const confirmed = snapshot(['app_access', 'manage_access'], { accessManagement: 'allowed' });

    expect(canVisitRoute(unconfirmed, 'access')).toBe(false);
    expect(canVisitRoute(confirmed, 'access')).toBe(true);
  });

  it('blocks a mutation immediately when the browser is offline', () => {
    const app = snapshot(['app_access', 'run_bulk_operations'], { canMutate: false });

    expect(canStartBulkChange(app)).toBe(false);
  });
});
