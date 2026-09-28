import type { QueryClient } from '@tanstack/react-query';
import { useForm } from '@tanstack/react-form';
import {
  Link,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from '@tanstack/react-router';

import { canVisitRoute, type ProductRoute } from '@/app/access-policy';
import type { AppAccessSnapshot } from '@/app/app-context';
import { AppShell } from '@/app/app-shell';
import { AppState } from '@/components/ui/app-state';
import { Card } from '@/components/ui/card';
import { AccessPage } from '@/features/access/access-page';
import {
  AccessAdminRepairPage,
  AccessCommandPage,
  AccessConfigurePage,
  AccessReviewPage,
} from '@/features/access/access-workflow';
import { ApiStatusCard, useHealth } from '@/features/health/api-status-card';
import { HomeDashboard } from '@/features/home/home-dashboard';
import { OperationProgressPage } from '@/features/operations/operation-progress-page';
import { RuntimeTable } from '@/features/status/runtime-table';
import { TaskFiltersPage } from '@/features/tasks/task-filters-page';
import { ru } from '@/locales/ru';

type RouterContext = {
  queryClient: QueryClient;
  app: AppAccessSnapshot;
};

export type StatusPanel = 'api' | 'runtime';

export function parseStatusSearch(search: Record<string, unknown>): { panel: StatusPanel } {
  return { panel: search.panel === 'runtime' ? 'runtime' : 'api' };
}

export function parseSubjectsSearch(search: Record<string, unknown>): { subjects: string } {
  const subjects = typeof search.subjects === 'string'
    ? [...new Set(search.subjects.split(',').filter((id) => /^\d{1,32}$/.test(id)))]
        .slice(0, 100)
        .join(',')
    : '';
  return { subjects };
}

export function parsePreflightSearch(search: Record<string, unknown>): { preflight: string } {
  const value = typeof search.preflight === 'string' ? search.preflight : '';
  return {
    preflight: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value)
      ? value
      : '',
  };
}

class RouteAccessError extends Error {
  public constructor(public readonly kind: 'forbidden' | 'unavailable') {
    super(kind);
  }
}

function routeGuard(route: ProductRoute) {
  return ({ context }: { context: RouterContext }) => {
    if (route === 'access' && context.app.accessManagement === 'unavailable') {
      throw new RouteAccessError('unavailable');
    }
    if (!canVisitRoute(context.app, route)) throw new RouteAccessError('forbidden');
  };
}

function ProtectedLayout() {
  const { app } = protectedRoute.useRouteContext();
  return <AppShell snapshot={app} />;
}

function RouteErrorState({ error }: { error: unknown }) {
  const unavailable = error instanceof RouteAccessError && error.kind === 'unavailable';
  return <div className="page-content"><AppState compact title={unavailable ? 'Управление доступом временно недоступно' : 'Нет доступа к разделу'} description={unavailable ? 'Не удалось безопасно подтвердить полномочия. Повторите проверку позже.' : 'Ваши текущие права не позволяют открыть этот раздел.'} action={<Link className="button-primary" to="/">На главную</Link>} /></div>;
}

function PlaceholderPage({ title }: { title: string }) {
  return <div className="page-content"><nav aria-label="Хлебные крошки" className="breadcrumbs"><span>Task Commander</span><i>/</i><strong>{title}</strong></nav><Card className="placeholder-card"><h1 tabIndex={-1}>{title}</h1><p>Раздел будет реализован на соответствующем этапе проекта.</p></Card></div>;
}

function StatusPanelForm({ panel }: { panel: StatusPanel }) {
  const form = useForm({ defaultValues: { panel } });
  return <form className="mt-4 flex items-end gap-3" onSubmit={(event) => event.preventDefault()}><form.Field name="panel">{(field) => <label className="grid gap-1 text-sm font-medium">{ru.status.panelLabel}<select className="rounded-md border border-border bg-background px-3 py-2" name={field.name} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value as StatusPanel)} value={field.state.value}><option value="api">{ru.status.apiPanel}</option><option value="runtime">{ru.status.runtimePanel}</option></select></label>}</form.Field></form>;
}

function StatusPage() {
  const { panel } = statusRoute.useSearch();
  const health = useHealth();
  const state = health.isPending ? ru.status.checking : health.isError ? ru.status.unavailable : ru.status.ready;
  return <div className="page-content"><Card><h1 tabIndex={-1}>{ru.status.title}</h1><StatusPanelForm panel={panel} />{panel === 'api' ? <ApiStatusCard /> : <RuntimeTable state={state} />}</Card></div>;
}

function LocalOnlyStatusPage() {
  if (import.meta.env.DEV) return <StatusPage />;
  return <AppState title="Страница не найдена" description="Проверьте адрес или вернитесь на главную страницу." action={<Link className="button-primary" to="/">На главную</Link>} />;
}

function HomePage() {
  const { app } = indexRoute.useRouteContext();
  return <HomeDashboard snapshot={app} />;
}

function ConfigureRoutePage() {
  const { subjects } = configureRoute.useSearch();
  return <AccessConfigurePage subjectIds={subjects.split(',').filter(Boolean)} />;
}

function ReviewRoutePage() {
  const { preflight } = reviewRoute.useSearch();
  return <AccessReviewPage preflightId={preflight} />;
}

function CommandRoutePage() {
  const { commandId } = commandRoute.useParams();
  return <AccessCommandPage commandId={commandId} />;
}

function OperationDetailRoutePage() {
  const { operationId } = operationDetailRoute.useParams();
  return <OperationProgressPage operationId={operationId} />;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  notFoundComponent: () => <AppState title="Страница не найдена" description="Проверьте адрес или вернитесь на главную страницу." action={<Link className="button-primary" to="/">На главную</Link>} />,
});
const statusRoute = createRoute({ getParentRoute: () => rootRoute, path: '/status', validateSearch: parseStatusSearch, component: LocalOnlyStatusPage });
const protectedRoute = createRoute({ getParentRoute: () => rootRoute, id: 'protected', beforeLoad: ({ context }) => ({ app: context.app }), component: ProtectedLayout, errorComponent: RouteErrorState });
const indexRoute = createRoute({ getParentRoute: () => protectedRoute, path: '/', beforeLoad: routeGuard('home'), component: HomePage });
const accessRoute = createRoute({ getParentRoute: () => protectedRoute, path: '/access', beforeLoad: routeGuard('access'), component: AccessPage, errorComponent: RouteErrorState });
const configureRoute = createRoute({ getParentRoute: () => protectedRoute, path: '/access/configure', beforeLoad: routeGuard('access'), validateSearch: parseSubjectsSearch, component: ConfigureRoutePage, errorComponent: RouteErrorState });
const reviewRoute = createRoute({ getParentRoute: () => protectedRoute, path: '/access/review', beforeLoad: routeGuard('access'), validateSearch: parsePreflightSearch, component: ReviewRoutePage, errorComponent: RouteErrorState });
const commandRoute = createRoute({ getParentRoute: () => protectedRoute, path: '/access/commands/$commandId', beforeLoad: routeGuard('access'), component: CommandRoutePage, errorComponent: RouteErrorState });
const repairRoute = createRoute({ getParentRoute: () => protectedRoute, path: '/access/admin-repair', beforeLoad: routeGuard('access'), component: AccessAdminRepairPage, errorComponent: RouteErrorState });
const tasksRoute = createRoute({ getParentRoute: () => protectedRoute, path: '/tasks', beforeLoad: routeGuard('tasks'), component: TaskFiltersPage, errorComponent: RouteErrorState });
const operationsRoute = createRoute({ getParentRoute: () => protectedRoute, path: '/operations', beforeLoad: routeGuard('operations'), component: OperationProgressPage, errorComponent: RouteErrorState });
const operationDetailRoute = createRoute({ getParentRoute: () => protectedRoute, path: '/operations/$operationId', beforeLoad: routeGuard('operations'), component: OperationDetailRoutePage, errorComponent: RouteErrorState });
const reportsRoute = createRoute({ getParentRoute: () => protectedRoute, path: '/reports', beforeLoad: routeGuard('reports'), component: () => <PlaceholderPage title="Отчёты" />, errorComponent: RouteErrorState });
const auditRoute = createRoute({ getParentRoute: () => protectedRoute, path: '/audit', beforeLoad: routeGuard('audit'), component: () => <PlaceholderPage title="Аудит" />, errorComponent: RouteErrorState });

const routeTree = rootRoute.addChildren([statusRoute, protectedRoute.addChildren([indexRoute, accessRoute, configureRoute, reviewRoute, commandRoute, repairRoute, tasksRoute, operationsRoute, operationDetailRoute, reportsRoute, auditRoute])]);

export const router = createRouter({
  routeTree,
  context: { queryClient: undefined!, app: undefined! },
});

declare module '@tanstack/react-router' {
  interface Register { router: typeof router; }
}
