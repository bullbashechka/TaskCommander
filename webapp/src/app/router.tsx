import { useForm } from '@tanstack/react-form';
import {
  Link,
  createRootRoute,
  createRoute,
  createRouter,
  useNavigate,
} from '@tanstack/react-router';

import { AppShell } from '@/app/app-shell';
import { Card } from '@/components/ui/card';
import { AccessPage } from '@/features/access/access-page';
import {
  AccessAdminRepairPage,
  AccessCommandPage,
  AccessConfigurePage,
  AccessReviewPage,
} from '@/features/access/access-workflow';
import { ApiStatusCard, useHealth } from '@/features/health/api-status-card';
import { RuntimeTable } from '@/features/status/runtime-table';
import { ru } from '@/locales/ru';

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

function FoundationPage() {
  return (
    <div className="page-content foundation-page">
      <p className="eyebrow">Рабочее пространство</p>
      <h1>Task Commander</h1>
      <p>Безопасная работа с задачами и системными инструментами Bitrix24.</p>
      <Link className="button-primary" to="/access">Открыть управление доступом</Link>
    </div>
  );
}

function PlaceholderPage({ title }: { title: string }) {
  return <div className="page-content"><nav aria-label="Хлебные крошки" className="breadcrumbs"><span>Task Commander</span><i>/</i><strong>{title}</strong></nav><Card className="placeholder-card"><h1>{title}</h1><p>Раздел будет реализован на соответствующем этапе проекта.</p></Card></div>;
}

function StatusPanelForm({ panel }: { panel: StatusPanel }) {
  const navigate = useNavigate({ from: '/status' });
  const form = useForm({ defaultValues: { panel }, onSubmit: async ({ value }) => { await navigate({ search: { panel: value.panel } }); } });
  return <form className="mt-4 flex items-end gap-3" onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}><form.Field name="panel">{(field) => <label className="grid gap-1 text-sm font-medium">{ru.status.panelLabel}<select className="rounded-md border border-border bg-background px-3 py-2" name={field.name} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value as StatusPanel)} value={field.state.value}><option value="api">{ru.status.apiPanel}</option><option value="runtime">{ru.status.runtimePanel}</option></select></label>}</form.Field><button className="button-secondary" type="submit">Применить</button></form>;
}

function StatusPage() {
  const { panel } = statusRoute.useSearch();
  const health = useHealth();
  const state = health.isPending ? ru.status.checking : health.isError ? ru.status.unavailable : ru.status.ready;
  return <div className="page-content"><Card><h1 className="text-xl font-semibold">{ru.status.title}</h1><StatusPanelForm panel={panel} />{panel === 'api' ? <ApiStatusCard /> : <RuntimeTable state={state} />}</Card></div>;
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

const rootRoute = createRootRoute({
  component: AppShell,
  notFoundComponent: () => <div className="page-content"><Card className="placeholder-card"><h1>Страница не найдена</h1><p>Проверьте адрес или вернитесь в раздел доступа.</p><Link className="button-primary" to="/access">К сотрудникам</Link></Card></div>,
});
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: FoundationPage });
const statusRoute = createRoute({ getParentRoute: () => rootRoute, path: '/status', validateSearch: parseStatusSearch, component: StatusPage });
const accessRoute = createRoute({ getParentRoute: () => rootRoute, path: '/access', component: AccessPage });
const configureRoute = createRoute({ getParentRoute: () => rootRoute, path: '/access/configure', validateSearch: parseSubjectsSearch, component: ConfigureRoutePage });
const reviewRoute = createRoute({ getParentRoute: () => rootRoute, path: '/access/review', validateSearch: parsePreflightSearch, component: ReviewRoutePage });
const commandRoute = createRoute({ getParentRoute: () => rootRoute, path: '/access/commands/$commandId', component: CommandRoutePage });
const repairRoute = createRoute({ getParentRoute: () => rootRoute, path: '/access/admin-repair', component: AccessAdminRepairPage });
const tasksRoute = createRoute({ getParentRoute: () => rootRoute, path: '/tasks', component: () => <PlaceholderPage title="Массовое изменение" /> });
const operationsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/operations', component: () => <PlaceholderPage title="Операции" /> });
const reportsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/reports', component: () => <PlaceholderPage title="Отчёты" /> });
const dataRoute = createRoute({ getParentRoute: () => rootRoute, path: '/data', component: () => <PlaceholderPage title="Данные" /> });
const auditRoute = createRoute({ getParentRoute: () => rootRoute, path: '/audit', component: () => <PlaceholderPage title="Аудит" /> });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: () => <PlaceholderPage title="Настройки" /> });

const routeTree = rootRoute.addChildren([indexRoute, statusRoute, accessRoute, configureRoute, reviewRoute, commandRoute, repairRoute, tasksRoute, operationsRoute, reportsRoute, dataRoute, auditRoute, settingsRoute]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register { router: typeof router; }
}
