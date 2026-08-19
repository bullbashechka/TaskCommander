import type { AppAccessSnapshot } from '@/app/app-context';
import { canVisitRoute, type ProductRoute } from '@/app/access-policy';

export type NavigationLink = Readonly<{
  label: string;
  to: string;
  route: ProductRoute;
}>;

export type NavigationModel = Readonly<{
  taskLinks: readonly NavigationLink[];
  systemLinks: readonly NavigationLink[];
}>;

const taskLinks: readonly NavigationLink[] = [
  { label: 'Массовое изменение', to: '/tasks', route: 'tasks' },
  { label: 'Операции', to: '/operations', route: 'operations' },
  { label: 'Отчёты', to: '/reports', route: 'reports' },
];

const systemLinks: readonly NavigationLink[] = [
  { label: 'Доступ', to: '/access', route: 'access' },
  { label: 'Аудит', to: '/audit', route: 'audit' },
];

export function createNavigationModel(snapshot: AppAccessSnapshot): NavigationModel {
  return Object.freeze({
    taskLinks: Object.freeze(taskLinks.filter((item) => canVisitRoute(snapshot, item.route))),
    systemLinks: Object.freeze(systemLinks.filter((item) => canVisitRoute(snapshot, item.route))),
  });
}
