import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { canStartBulkChange, canVisitRoute } from '@/app/access-policy';
import {
  type AppAccessSnapshot,
  type HomeDashboardModel,
  unavailableHomeDashboardModel,
} from '@/app/app-context';

type HomeDashboardProps = {
  snapshot: AppAccessSnapshot;
  model?: HomeDashboardModel;
};

function DashboardCard({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`dashboard-card ${className}`.trim()}>{children}</section>;
}

export function HomeDashboard({ snapshot, model = unavailableHomeDashboardModel }: HomeDashboardProps) {
  const canOpenTasks = canVisitRoute(snapshot, 'tasks');
  const canRun = canOpenTasks && canStartBulkChange(snapshot);
  const displayName = snapshot.principal.displayName.trim() || 'Пользователь';
  const summary = model.summary.status === 'ready' ? model.summary.data : null;
  const operations = model.activeOperations.status === 'ready' ? model.activeOperations.data : [];
  const results = model.recentResults.status === 'ready' ? model.recentResults.data : [];
  const attention = model.attention.status === 'ready' ? model.attention.data : [];

  return (
    <div className="page-content dashboard-page">
      <nav aria-label="Хлебные крошки" className="breadcrumbs"><strong>Главная</strong></nav>
      <header className="dashboard-hero">
        <div>
          <h1 tabIndex={-1}>Добрый день, {displayName}</h1>
          <p>Сводка массовых операций и доступных действий.</p>
          <span className="dashboard-verified">✓ Сессия и права Bitrix24 проверены только что</span>
        </div>
        <div aria-hidden="true" className="dashboard-architecture" />
      </header>

      {summary ? <section aria-label="Сводные показатели" className="dashboard-kpis">
        <DashboardCard><span>Выполняется</span><strong>{summary.running}</strong></DashboardCard>
        <DashboardCard><span>Завершено за 30 дней</span><strong>{summary.completedLast30Days}</strong></DashboardCard>
        <DashboardCard><span>Обработано задач</span><strong>{summary.processedTasksLast30Days}</strong></DashboardCard>
        <DashboardCard><span>Требует внимания</span><strong>{summary.attentionCount}</strong></DashboardCard>
      </section> : null}

      <section className="dashboard-grid">
        <div className="dashboard-main-column">
          {operations.length > 0 ? <DashboardCard>
            <h2>Текущие операции</h2>
            <div className="dashboard-table"><div className="dashboard-row dashboard-row-head"><span>Операция</span><span>Статус</span><span>Прогресс</span><span>Обработано</span></div>{operations.map((operation) => <Link className="dashboard-row" key={operation.id} to="/operations"><span>{operation.title}</span><span className={`dashboard-tone-${operation.tone}`}>{operation.status}</span><span><i className="dashboard-progress"><b style={{ width: `${operation.progress}%` }} /></i>{operation.progress}%</span><span>{operation.processed}</span></Link>)}</div>
            <Link className="dashboard-footer-link" to="/operations">Все операции</Link>
          </DashboardCard> : null}
          {results.length > 0 ? <DashboardCard>
            <h2>Последние результаты</h2>
            <div className="dashboard-table"><div className="dashboard-row dashboard-row-head"><span>Операция</span><span>Завершена</span><span>Задачи</span><span>Результат</span></div>{results.map((result) => <Link className="dashboard-row" key={result.id} to="/operations"><span>{result.title}</span><span>{result.completedAt}</span><span>{result.taskCount}</span><span className={`dashboard-tone-${result.tone}`}>{result.result}</span></Link>)}</div>
            <Link className="dashboard-footer-link" to="/operations">Открыть историю</Link>
          </DashboardCard> : null}
          {!summary && operations.length === 0 && results.length === 0 ? <DashboardCard className="dashboard-empty-work"><h2>Работа начнётся здесь</h2><p>Когда появятся операции и отчёты, здесь будут показаны их актуальные статусы и результаты.</p></DashboardCard> : null}
        </div>
        <aside className="dashboard-side-column">
          <DashboardCard className="dashboard-quick-start"><h2>Быстрый запуск</h2><p>{canRun ? 'Найдите задачи, настройте изменения и проверьте результат до запуска.' : 'Просмотрите доступные задачи и узнайте, какие действия доступны вам.'}</p>{canRun ? <Link className="button-primary" to="/tasks">Начать массовое изменение</Link> : canOpenTasks ? <Link className="button-primary" to="/tasks">Открыть задачи</Link> : null}</DashboardCard>
          {attention.length > 0 ? <DashboardCard><h2>Требует внимания</h2><ul className="dashboard-attention">{attention.map((item) => <li key={item.id}><span className={`dashboard-tone-${item.tone}`}>{item.title}</span><Link to="/operations">{item.action}</Link></li>)}</ul></DashboardCard> : null}
        </aside>
      </section>
    </div>
  );
}
