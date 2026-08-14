import { type ReactNode } from 'react';

type AppStateProps = {
  title: string;
  description: string;
  action?: ReactNode;
  eventId?: string;
  compact?: boolean;
};

export function AppState({ title, description, action, eventId, compact = false }: AppStateProps) {
  const content = (
    <section aria-live="polite" className="app-state-card">
      <h1 tabIndex={-1}>{title}</h1>
      <p>{description}</p>
      {eventId ? <small>Код события: {eventId}</small> : null}
      {action ? <div className="app-state-actions">{action}</div> : null}
    </section>
  );
  return compact ? content : <main className="app-state-page">{content}</main>;
}
