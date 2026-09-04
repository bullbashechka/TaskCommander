import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';

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
    <Link aria-label="Task Commander — Главная" className="brand" title="Task Commander — Главная" to="/">
      <span className="brand-mark"><Icons.check /></span>
      <span>Task<br />Commander</span>
    </Link>
  );
}

function useCompactNavigation(): boolean {
  const mediaQuery = '(max-width: 1179px)';
  const [compact, setCompact] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(mediaQuery).matches;
  });

  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const query = window.matchMedia(mediaQuery);
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return compact;
}

export function AppShell({ snapshot }: { snapshot: AppAccessSnapshot }) {
  const navigation = createNavigationModel(snapshot);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const currentTaskRoute = pathname === '/tasks' || pathname === '/operations' || pathname === '/reports';
  const compactNavigation = useCompactNavigation();
  const [tasksExpanded, setTasksExpanded] = useState(currentTaskRoute);
  const [taskFlyoutTop, setTaskFlyoutTop] = useState(0);
  const [taskFlyoutMaxHeight, setTaskFlyoutMaxHeight] = useState(0);
  const taskButtonRef = useRef<HTMLButtonElement>(null);
  const displayName = snapshot.principal.displayName.trim() || 'Пользователь Bitrix24';
  const role = snapshot.principal.isBitrixAdmin ? 'Администратор Bitrix24' : 'Пользователь';
  const showTasks = navigation.taskLinks.length > 0;
  const tasksOpen = tasksExpanded || (!compactNavigation && currentTaskRoute);

  useEffect(() => {
    const heading = document.querySelector<HTMLElement>('.workspace h1[tabindex="-1"]');
    heading?.focus({ preventScroll: true });
  }, [pathname]);

  useEffect(() => {
    if (compactNavigation) setTasksExpanded(false);
  }, [compactNavigation, pathname]);

  useEffect(() => {
    if (!compactNavigation || !tasksOpen) return undefined;
    const updateFlyoutPosition = () => {
      const top = taskButtonRef.current?.getBoundingClientRect().top ?? 0;
      setTaskFlyoutTop(top);
      setTaskFlyoutMaxHeight(Math.max(120, window.innerHeight - top - 8));
    };
    updateFlyoutPosition();
    window.addEventListener('resize', updateFlyoutPosition);
    return () => window.removeEventListener('resize', updateFlyoutPosition);
  }, [compactNavigation, tasksOpen]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <nav
          aria-label="Основная навигация"
          className="sidebar-nav"
          onScroll={() => {
            if (compactNavigation) setTasksExpanded(false);
          }}
        >
          <Link activeOptions={{ exact: true }} activeProps={{ 'aria-current': 'page' }} aria-label="Главная" className="sidebar-link" title="Главная" to="/">
            <Icons.home /><span>Главная</span>
          </Link>

          {showTasks ? <>
            <p className="sidebar-section">Инструменты</p>
            <div className="sidebar-group">
              <button
                aria-controls="tasks-navigation"
                aria-expanded={tasksOpen}
                aria-label="Задачи"
                className="sidebar-link sidebar-group-title"
                onClick={() => setTasksExpanded((expanded) => !expanded)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setTasksExpanded(false);
                }}
                ref={taskButtonRef}
                title="Задачи"
                type="button"
              >
                <Icons.tasks /><span>Задачи</span><Icons.chevronDown className="sidebar-chevron" />
              </button>
              {tasksOpen ? <div
                className="sidebar-children"
                id="tasks-navigation"
                onKeyDown={(event) => {
                  if (event.key !== 'Escape') return;
                  event.preventDefault();
                  setTasksExpanded(false);
                  taskButtonRef.current?.focus();
                }}
                style={
                  compactNavigation
                    ? { maxHeight: taskFlyoutMaxHeight, top: taskFlyoutTop }
                    : undefined
                }
              >
                {navigation.taskLinks.map((item) => <Link activeProps={{ 'aria-current': 'page' }} aria-label={item.label} className="sidebar-child" key={item.to} onClick={() => setTasksExpanded(false)} title={item.label} to={item.to as never}><span>{item.label}</span></Link>)}
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
