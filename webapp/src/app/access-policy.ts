import type { AppAccessSnapshot } from '@/app/app-context';

export type ProductRoute = 'home' | 'tasks' | 'operations' | 'reports' | 'access' | 'audit';

const developmentOnlyRoutes: readonly ProductRoute[] = ['tasks', 'operations', 'reports', 'audit'];

export function isRouteAvailable(route: ProductRoute): boolean {
  return import.meta.env.DEV || !developmentOnlyRoutes.includes(route);
}

export function canVisitRoute(snapshot: AppAccessSnapshot, route: ProductRoute): boolean {
  if (!isRouteAvailable(route)) return false;
  const permissions = snapshot.access.permissions;
  switch (route) {
    case 'home':
    case 'tasks':
      return permissions.includes('app_access');
    case 'operations':
      return permissions.includes('run_bulk_operations') ||
        permissions.includes('view_own_reports') ||
        permissions.includes('view_all_reports');
    case 'reports':
      return permissions.includes('view_own_reports') || permissions.includes('view_all_reports');
    case 'access':
      return snapshot.accessManagement === 'allowed';
    case 'audit':
      return permissions.includes('view_audit');
  }
}

export function canStartBulkChange(snapshot: AppAccessSnapshot): boolean {
  return (
    snapshot.canMutate &&
    snapshot.access.permissions.includes('run_bulk_operations') &&
    snapshot.access.permissions.includes('change_allowed_fields') &&
    (snapshot.access.fieldScope.kind === 'all' || snapshot.access.fieldScope.fieldIds.length > 0)
  );
}

export function hasEmptyFieldScope(snapshot: AppAccessSnapshot): boolean {
  return snapshot.access.fieldScope.kind === 'subset' && snapshot.access.fieldScope.fieldIds.length === 0;
}

export function bulkChangeAccessFingerprint(snapshot: AppAccessSnapshot): string {
  const relevantPermissions = (
    ['app_access', 'run_bulk_operations', 'change_allowed_fields'] as const
  ).filter((permission) => snapshot.access.permissions.includes(permission));
  const fieldIds =
    snapshot.access.fieldScope.kind === 'all'
      ? ['*']
      : [...snapshot.access.fieldScope.fieldIds].sort();
  return JSON.stringify([relevantPermissions, fieldIds]);
}
