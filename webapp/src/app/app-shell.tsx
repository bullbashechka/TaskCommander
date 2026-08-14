import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

import type { AppAccessSnapshot } from '@/app/app-context';
import { createNavigationModel } from '@/app/navigation-model';
import { Icons } from '@/components/ui/icons';

function initials(displayName: string): string {
  const value = displayName.trim();
  if (!value) return 'П';
  return value.split(/\s+/).slice(0, 2).map((part) => part.charAt(0)).join('').toUpperCase();
}

function Brand() {
  return (
    <Link className="brand" to="/">
      <span className="brand-mark"><Icons.check /></span>
      <span>Task<br />Commander</span>
    </Link>
  );
}

export function AppShell({ snapshot }: { snapshot: AppAccessSnapshot }) {
  const navigation = createNavigationModel(snapshot);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const currentTaskRoute = pathname === '/tasks' || pathname === '/operations' || pathname === '/reports';
  const [tasksExpanded, setTasksExpanded] = useState(currentTaskRoute);
  const displayName = snapshot.principal.displayName.trim() || 'Пользователь Bitrix24';
  const role = snapshot.principal.isBitrixAdmin ? 'Администратор Bitrix24' : 'Пользователь';
  const showTasks = navigation.taskLinks.length > 0;

  useEffect(() => {
    const heading = document.querySelector<HTMLElement>('.workspace h1[tabindex="-1"]');
    heading?.focus({ preventScroll: true });
  }, [pathname]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <nav aria-label="Основная навигация" className="sidebar-nav">
          <Link activeOptions={{ exact: true }} activeProps={{ 'aria-current': 'page' }} aria-label="Главная" className="sidebar-link" title="Главная" to="/">
            <Icons.home /><span>Главная</span>
          </Link>

          {showTasks ? <>
            <p className="sidebar-section">Инструменты</p>
            <div className="sidebar-group">
              <button aria-controls="tasks-navigation" aria-expanded={tasksExpanded || currentTaskRoute} className="sidebar-link sidebar-group-title" onClick={() => setTasksExpanded((expanded) => !expanded)} type="button">
                <Icons.tasks /><span>Задачи</span><Icons.chevronDown className="sidebar-chevron" />
              </button>
              {tasksExpanded || currentTaskRoute ? <div className="sidebar-children" id="tasks-navigation">
                {navigation.taskLinks.map((item) => <Link aria-label={item.label} className="sidebar-child" key={item.to} title={item.label} to={item.to as never}><span>{item.label}</span></Link>)}
              </div> : null}
            </div>
          </> : null}

          {navigation.systemLinks.length > 0 ? <>
            <p className="sidebar-section">Система</p>
            {navigation.systemLinks.map((item) => <Link activeProps={{ 'aria-current': 'page' }} aria-label={item.label} className="sidebar-link" key={item.to} title={item.label} to={item.to as never}>
              {item.route === 'access' ? <Icons.users /> : <Icons.audit />}<span>{item.label}</span>
            </Link>)}
          </> : null}
        </nav>
        <div className="sidebar-bottom">
          <div aria-label={`Профиль: ${displayName}, ${role}`} className="profile-static" title={displayName}>
            <span aria-hidden="true" className="avatar avatar-current">{initials(displayName)}</span>
            <span className="profile-copy"><strong>{displayName}</strong><small>{role}</small></span>
          </div>
        </div>
      </aside>
      <main className="workspace">
        <Outlet />
      </main>
    </div>
  );
}
