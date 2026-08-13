import { sessionResponseSchema } from '@task-commander/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link, Outlet } from '@tanstack/react-router';

import { Icons } from '@/components/ui/icons';

const tasks = [
  ['Массовое изменение', '/tasks'],
  ['Операции', '/operations'],
  ['Отчёты', '/reports'],
] as const;

function Brand() {
  return (
    <Link className="brand" to="/">
      <span className="brand-mark"><Icons.check /></span>
      <span>Task<br />Commander</span>
    </Link>
  );
}

export function AppShell() {
  const session = useQuery({
    queryKey: ['session'],
    queryFn: async () => {
      const response = await fetch('/api/session', { headers: { accept: 'application/json' } });
      if (!response.ok) return null;
      return sessionResponseSchema.parse(await response.json()).principal;
    },
    retry: false,
  });
  const displayName = session.data?.displayName ?? 'Пользователь Bitrix24';
  const initials = displayName
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('');
  const role = session.data?.isBitrixAdmin ? 'Администратор' : 'Руководитель';
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <nav aria-label="Основная навигация" className="sidebar-nav">
          <Link aria-label="Главная" title="Главная" activeOptions={{ exact: true }} activeProps={{ 'aria-current': 'page' }} className="sidebar-link" to="/">
            <Icons.home /><span>Главная</span>
          </Link>

          <p className="sidebar-section">Инструменты</p>
          <div className="sidebar-group">
            <div aria-label="Задачи" className="sidebar-link sidebar-group-title" title="Задачи"><Icons.tasks /><span>Задачи</span><Icons.chevronDown className="sidebar-chevron" /></div>
            <div className="sidebar-children">
              {tasks.map(([label, to]) => (
                <Link aria-label={label} className="sidebar-child" key={to} title={label} to={to}><span>{label}</span></Link>
              ))}
            </div>
          </div>
          <Link aria-label="Данные" className="sidebar-link" title="Данные" to="/data"><Icons.database /><span>Данные</span><Icons.arrow className="sidebar-chevron" /></Link>

          <p className="sidebar-section">Система</p>
          <Link aria-label="Доступ" activeProps={{ 'aria-current': 'page' }} className="sidebar-link" title="Доступ" to="/access"><Icons.users /><span>Доступ</span></Link>
          <Link aria-label="Аудит" className="sidebar-link" title="Аудит" to="/audit"><Icons.audit /><span>Аудит</span></Link>
        </nav>

        <div className="sidebar-bottom">
          <Link aria-label="Настройки" className="sidebar-link" title="Настройки" to="/settings"><Icons.settings /><span>Настройки</span></Link>
          <button aria-label={`Профиль: ${displayName}`} className="profile-button" title={displayName} type="button">
            <span className="avatar avatar-current" aria-hidden="true">{initials}</span>
            <span className="profile-copy"><strong>{displayName}</strong><small>{role}</small></span>
            <Icons.chevronDown />
          </button>
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div className="topbar-spacer" />
          <button aria-label="Уведомления: есть новые" className="icon-button notification-button" type="button"><Icons.bell /><span /></button>
          <button aria-label="Открыть профиль" className="topbar-avatar" type="button"><span className="avatar avatar-current" aria-hidden="true">{initials}</span></button>
        </header>
        <Outlet />
      </main>
    </div>
  );
}
