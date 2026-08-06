import { useForm } from '@tanstack/react-form';
import {
  Link,
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  useNavigate,
} from '@tanstack/react-router';

import { Card } from '@/components/ui/card';
import { ApiStatusCard, useHealth } from '@/features/health/api-status-card';
import { RuntimeTable } from '@/features/status/runtime-table';
import { ru } from '@/locales/ru';

export type StatusPanel = 'api' | 'runtime';

export function parseStatusSearch(search: Record<string, unknown>): { panel: StatusPanel } {
  return { panel: search.panel === 'runtime' ? 'runtime' : 'api' };
}

function AppShell() {
  return (
    <main className="app-shell">
      <section className="mx-auto max-w-4xl px-6 py-12">
        <div className="mb-8 flex items-center justify-between gap-4">
          <div>
            <p className="eyebrow">{ru.app.localEnvironment}</p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight">{ru.app.name}</h1>
          </div>
          <nav aria-label="Основная навигация" className="flex gap-4 text-sm font-medium">
            <Link activeProps={{ className: 'nav-link-active' }} className="nav-link" to="/">
              {ru.navigation.home}
            </Link>
            <Link
              activeProps={{ className: 'nav-link-active' }}
              className="nav-link"
              search={{ panel: 'api' }}
              to="/status"
            >
              {ru.navigation.status}
            </Link>
          </nav>
        </div>
        <Outlet />
      </section>
    </main>
  );
}

function FoundationPage() {
  return (
    <div className="grid gap-6">
      <Card>
        <h2 className="text-xl font-semibold">{ru.app.foundationReady}</h2>
        <p className="mt-2 max-w-2xl text-muted-foreground">{ru.app.foundationDescription}</p>
      </Card>
      <ApiStatusCard />
    </div>
  );
}

function StatusPanelForm({ panel }: { panel: StatusPanel }) {
  const navigate = useNavigate({ from: '/status' });
  const form = useForm({
    defaultValues: { panel },
    onSubmit: async ({ value }) => {
      await navigate({ search: { panel: value.panel } });
    },
  });

  return (
    <form
      className="mt-4 flex items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <form.Field name="panel">
        {(field) => (
          <label className="grid gap-1 text-sm font-medium">
            {ru.status.panelLabel}
            <select
              className="rounded-md border border-border bg-background px-3 py-2"
              name={field.name}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value as StatusPanel)}
              value={field.state.value}
            >
              <option value="api">{ru.status.apiPanel}</option>
              <option value="runtime">{ru.status.runtimePanel}</option>
            </select>
          </label>
        )}
      </form.Field>
      <button className="button-secondary" type="submit">
        Применить
      </button>
    </form>
  );
}

function StatusPage() {
  const { panel } = statusRoute.useSearch();
  const health = useHealth();
  const state = health.isPending
    ? ru.status.checking
    : health.isError
      ? ru.status.unavailable
      : ru.status.ready;

  return (
    <Card>
      <h2 className="text-xl font-semibold">{ru.status.title}</h2>
      <StatusPanelForm panel={panel} />
      {panel === 'api' ? <ApiStatusCard /> : <RuntimeTable state={state} />}
    </Card>
  );
}

const rootRoute = createRootRoute({ component: AppShell });
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: FoundationPage,
});
const statusRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/status',
  validateSearch: parseStatusSearch,
  component: StatusPage,
});

const routeTree = rootRoute.addChildren([indexRoute, statusRoute]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
