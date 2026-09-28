import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';

import type { OperationProgress, TaskOutcome } from '@task-commander/contracts';

import {
  AppApiError,
  cancelOperation,
  getCurrentOperationProgress,
  getOperationProgress,
  getOperationProgressResults,
  retryTaskOperationLaunch,
} from '@/app/app-api';
import { useAppAccess } from '@/app/app-context';
import { AppState } from '@/components/ui/app-state';
import { Card } from '@/components/ui/card';

const terminal = new Set([
  'completed',
  'completed_with_errors',
  'cancelled',
  'interrupted',
  'launch_failed',
]);

const statusLabels: Record<string, string> = {
  launching: 'Подготовка запуска',
  running: 'Выполняется',
  completed: 'Завершена',
  completed_with_errors: 'Завершена с ошибками',
  cancelled: 'Отменена',
  interrupted: 'Прервана',
  launch_failed: 'Не удалось запустить',
};
const outcomeLabels: Record<TaskOutcome['outcome'], string> = {
  success: 'Успешно',
  error: 'Ошибка',
  unconfirmed: 'Не подтверждено',
  conflict: 'Конфликт',
  excluded_by_preflight: 'Исключено проверкой',
  not_processed: 'Не обработано',
  restored: 'Восстановлено',
  restore_error: 'Ошибка восстановления',
  no_change: 'Без изменений',
  partially_applied: 'Частично применено',
};

export function OperationProgressPage({ operationId }: { operationId?: string }) {
  const app = useAppAccess();
  const [progress, setProgress] = useState<OperationProgress | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<'access' | 'missing' | 'offline' | 'temporary' | null>(null);
  const [cancelPending, setCancelPending] = useState(false);
  const [cancelError, setCancelError] = useState('');
  const [retryPending, setRetryPending] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [results, setResults] = useState<TaskOutcome[]>([]);
  const [nextResultsCursor, setNextResultsCursor] = useState<string | null>(null);
  const [resultsLoading, setResultsLoading] = useState(false);
  const [resultsError, setResultsError] = useState(false);
  const [morePending, setMorePending] = useState(false);
  const latest = useRef<OperationProgress | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const scope = useRef('');
  const accessRevoked = useRef(false);
  const identity = `${app?.generation ?? 0}:${app?.principal.portalId ?? ''}:${app?.principal.userId ?? ''}`;
  const currentScope = `${identity}:${operationId ?? 'current'}`;

  useEffect(() => {
    let active = true;
    let inFlight = false;
    accessRevoked.current = false;
    if (scope.current !== currentScope) {
      scope.current = currentScope;
      latest.current = null;
      setProgress(null);
      setResults([]);
      setNextResultsCursor(null);
      setCancelPending(false);
      setCancelError('');
      setRetryPending(false);
      setMorePending(false);
    }
    setError(null);
    setLoading(true);
    async function poll() {
      if (inFlight || accessRevoked.current) return;
      inFlight = true;
      try {
        const next = operationId
          ? await getOperationProgress(operationId)
          : await getCurrentOperationProgress();
        if (!active || accessRevoked.current) return;
        if (next?.operation.id !== latest.current?.operation.id) {
          setResults([]);
          setNextResultsCursor(null);
          setResultsError(false);
          setCancelPending(false);
          setCancelError('');
          setRetryPending(false);
          setMorePending(false);
        }
        if (
          next &&
          (!latest.current ||
            next.operation.id !== latest.current.operation.id ||
            next.operation.stateVersion >= latest.current.operation.stateVersion)
        ) {
          latest.current = next;
          setProgress(next);
        }
        if (next === null) {
          latest.current = null;
          setProgress(null);
        }
        setError(null);
      } catch (failure) {
        if (!active) return;
        if (
          failure instanceof AppApiError &&
          (failure.kind === 'access_denied' || failure.kind === 'session_required')
        ) {
          accessRevoked.current = true;
          latest.current = null;
          setProgress(null);
          setResults([]);
          setNextResultsCursor(null);
          setError('access');
        } else if (failure instanceof AppApiError && failure.status === 404) {
          latest.current = null;
          setProgress(null);
          setResults([]);
          setNextResultsCursor(null);
          setError('missing');
        } else {
          setError(
            failure instanceof AppApiError && failure.kind === 'offline' ? 'offline' : 'temporary',
          );
        }
      } finally {
        if (active) setLoading(false);
        inFlight = false;
      }
    }
    void poll();
    const interval = window.setInterval(() => void poll(), 3000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [currentScope, operationId, refreshNonce]);

  useEffect(() => {
    const id = progress?.operation.id;
    if (!id) return;
    let active = true;
    setResultsLoading(true);
    void getOperationProgressResults(id)
      .then((page) => {
        if (!active || scope.current !== currentScope || latest.current?.operation.id !== id)
          return;
        setResults(page.items);
        setNextResultsCursor(page.nextCursor);
        setResultsError(false);
      })
      .catch((failure: unknown) => {
        if (!active || scope.current !== currentScope || latest.current?.operation.id !== id)
          return;
        if (
          failure instanceof AppApiError &&
          (failure.kind === 'access_denied' ||
            failure.kind === 'session_required' ||
            failure.status === 404)
        ) {
          accessRevoked.current = true;
          latest.current = null;
          setProgress(null);
          setResults([]);
          setNextResultsCursor(null);
          setError(failure.status === 404 ? 'missing' : 'access');
        } else {
          setResultsError(true);
        }
      })
      .finally(() => {
        if (active) setResultsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [currentScope, progress?.operation.id, progress?.operation.stateVersion]);

  useEffect(() => {
    if (!progress || terminal.has(progress.operation.status)) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [progress]);
  useEffect(() => {
    if (progress) heading.current?.focus();
  }, [progress?.operation.id]);

  async function cancel() {
    if (!progress || cancelPending || terminal.has(progress.operation.status)) return;
    const requestedScope = currentScope;
    const requestedId = progress.operation.id;
    setCancelPending(true);
    setCancelError('');
    try {
      const next = await cancelOperation(progress.operation.id);
      if (scope.current !== requestedScope || latest.current?.operation.id !== requestedId) return;
      const current = latest.current;
      if (
        !current ||
        current.operation.id !== next.operation.id ||
        next.operation.stateVersion >= current.operation.stateVersion
      ) {
        latest.current = next;
        setProgress(next);
      }
    } catch (failure) {
      if (scope.current !== requestedScope || latest.current?.operation.id !== requestedId) return;
      if (
        failure instanceof AppApiError &&
        (failure.kind === 'access_denied' || failure.kind === 'session_required')
      ) {
        latest.current = null;
        setProgress(null);
        setResults([]);
        setNextResultsCursor(null);
        setCancelPending(false);
        setError('access');
      } else {
        setCancelError('Не удалось запросить отмену. Проверьте состояние операции и повторите.');
      }
    } finally {
      if (scope.current === requestedScope && latest.current?.operation.id === requestedId)
        setCancelPending(false);
    }
  }

  async function retryLaunch() {
    if (!progress || retryPending || progress.operation.status !== 'launch_failed') return;
    const requestedScope = currentScope;
    const requestedId = progress.operation.id;
    setRetryPending(true);
    setCancelError('');
    try {
      const operation = await retryTaskOperationLaunch(progress.operation.id);
      if (scope.current !== requestedScope || latest.current?.operation.id !== requestedId) return;
      const next: OperationProgress = { ...progress, operation };
      if (!latest.current || operation.stateVersion >= latest.current.operation.stateVersion) {
        latest.current = next;
        setProgress(next);
      }
    } catch (failure) {
      if (scope.current !== requestedScope || latest.current?.operation.id !== requestedId) return;
      if (
        failure instanceof AppApiError &&
        (failure.kind === 'session_required' || failure.kind === 'access_denied')
      ) {
        if (failure.kind === 'session_required') accessRevoked.current = true;
        latest.current = null;
        setProgress(null);
        setResults([]);
        setNextResultsCursor(null);
        setRetryPending(false);
        setError('access');
      } else {
        setCancelError('Не удалось повторить запуск. Обновите состояние операции и повторите.');
      }
    } finally {
      if (scope.current === requestedScope && latest.current?.operation.id === requestedId)
        setRetryPending(false);
    }
  }

  async function loadMoreResults() {
    if (!progress || !nextResultsCursor || morePending) return;
    const requestedScope = currentScope;
    const requestedId = progress.operation.id;
    const requestedVersion = progress.operation.stateVersion;
    setMorePending(true);
    try {
      const page = await getOperationProgressResults(progress.operation.id, nextResultsCursor);
      if (
        scope.current !== requestedScope ||
        latest.current?.operation.id !== requestedId ||
        latest.current?.operation.stateVersion !== requestedVersion
      )
        return;
      setResults((current) => [...current, ...page.items]);
      setNextResultsCursor(page.nextCursor);
      setResultsError(false);
    } catch (failure) {
      if (scope.current !== requestedScope || latest.current?.operation.id !== requestedId) return;
      if (
        failure instanceof AppApiError &&
        (failure.kind === 'access_denied' ||
          failure.kind === 'session_required' ||
          failure.status === 404)
      ) {
        accessRevoked.current = true;
        latest.current = null;
        setProgress(null);
        setResults([]);
        setNextResultsCursor(null);
        setError(failure.status === 404 ? 'missing' : 'access');
      } else {
        setResultsError(true);
      }
    } finally {
      if (scope.current === requestedScope && latest.current?.operation.id === requestedId)
        setMorePending(false);
    }
  }

  if (scope.current !== currentScope || (loading && !progress))
    return (
      <div className="page-content">
        <AppState
          title="Загружаем выполнение"
          description="Получаем сохранённое состояние операции."
        />
      </div>
    );
  if (error === 'access')
    return (
      <div className="page-content">
        <AppState
          title="Нет доступа к операции"
          description="Права изменились. Выполнение на сервере проверит доступ перед следующей задачей."
        />
      </div>
    );
  if (error === 'missing')
    return (
      <div className="page-content">
        <AppState
          title="Операция не найдена"
          description="Проверьте ссылку или вернитесь к операциям."
          action={
            <Link className="button-secondary" to="/operations">
              К операциям
            </Link>
          }
        />
      </div>
    );
  if (!progress && (error === 'offline' || error === 'temporary'))
    return (
      <div className="page-content">
        <AppState
          title={error === 'offline' ? 'Нет соединения' : 'Не удалось загрузить операцию'}
          description="Состояние операции сохранено на сервере."
          action={
            <button
              className="button-secondary"
              onClick={() => setRefreshNonce((value) => value + 1)}
              type="button"
            >
              Повторить загрузку
            </button>
          }
        />
      </div>
    );
  if (!progress)
    return (
      <div className="page-content">
        <AppState
          title="Операций пока нет"
          description="После запуска здесь появится ход выполнения. История операций будет доступна в отдельном разделе."
          action={
            <Link className="button-secondary" to="/tasks">
              К задачам
            </Link>
          }
        />
      </div>
    );

  const { operation, processed, remaining, percent } = progress;
  const { summary } = operation;
  const stopping = Boolean(operation.cancelRequestedAt || operation.interruptionRequestedAt);
  const canCancel = app?.access.permissions.includes('run_bulk_operations') ?? false;
  const canRetryLaunch =
    canCancel && (app?.access.permissions.includes('retry_operations') ?? false);
  return (
    <div className="page-content">
      <nav aria-label="Хлебные крошки" className="breadcrumbs">
        <Link to="/operations">Операции</Link>
        <i>/</i>
        <strong>Выполнение</strong>
      </nav>
      <Card>
        <h1 ref={heading} tabIndex={-1}>
          Выполнение операции
        </h1>
        <p role="status" aria-live="polite">
          {stopping && !terminal.has(operation.status)
            ? 'Останавливается после текущей задачи'
            : statusLabels[operation.status]}
        </p>
        <p>
          Задач с зафиксированным итогом: {processed} из {summary.eligible} · {percent}%
        </p>
        {summary.eligible === 0 && operation.status === 'completed' ? (
          <p>Задач для изменения нет. Изменения не выполнялись.</p>
        ) : null}
        <progress aria-label="Доля задач с зафиксированным итогом" max={100} value={percent} />
        <dl>
          <dt>Выбрано</dt>
          <dd>{summary.selected}</dd>
          <dt>Исключено проверкой</dt>
          <dd>{summary.excluded}</dd>
          <dt>Без изменений</dt>
          <dd>{summary.unchanged}</dd>
          <dt>Успешно</dt>
          <dd>{summary.successful}</dd>
          <dt>Ошибки</dt>
          <dd>{summary.failed}</dd>
          <dt>Не подтверждено</dt>
          <dd>{summary.unconfirmed}</dd>
          <dt>Конфликты</dt>
          <dd>{summary.conflicted}</dd>
          <dt>Частично применено</dt>
          <dd>{summary.partiallyApplied}</dd>
          <dt>Не обработано</dt>
          <dd>{summary.notProcessed}</dd>
          <dt>Осталось</dt>
          <dd>{remaining}</dd>
        </dl>
        {!terminal.has(operation.status) ? (
          <p>
            При закрытии страницы операция продолжится на сервере. Вернитесь в этот раздел, чтобы
            увидеть результат.
          </p>
        ) : null}
        {error === 'offline' || error === 'temporary' ? (
          <p role="alert">
            Не удалось обновить прогресс. Показано последнее сохранённое состояние; проверка
            повторится автоматически.{' '}
            <button
              className="button-secondary"
              onClick={() => setRefreshNonce((value) => value + 1)}
              type="button"
            >
              Обновить сейчас
            </button>
          </p>
        ) : null}
        {cancelError ? <p role="alert">{cancelError}</p> : null}
        {canCancel && !stopping && !terminal.has(operation.status) ? (
          <button
            className="button-secondary"
            disabled={cancelPending}
            onClick={() => void cancel()}
            type="button"
          >
            {cancelPending ? 'Отменяем…' : 'Отменить операцию'}
          </button>
        ) : null}
        {canRetryLaunch && operation.status === 'launch_failed' ? (
          <button
            className="button-secondary"
            disabled={retryPending}
            onClick={() => void retryLaunch()}
            type="button"
          >
            {retryPending ? 'Повторяем запуск…' : 'Повторить запуск'}
          </button>
        ) : null}
      </Card>
      <Card>
        <h2>Результаты задач</h2>
        {resultsLoading && results.length === 0 ? <p role="status">Загружаем результаты…</p> : null}
        {!resultsLoading && results.length === 0 && !resultsError ? (
          <p>Результатов пока нет.</p>
        ) : null}
        {resultsError ? (
          <p role="alert">Не удалось обновить список результатов. Прогресс операции сохранён.</p>
        ) : null}
        {results.length > 0 ? (
          <ul>
            {results.map((result) => (
              <li key={result.taskId}>
                {result.taskUrl ? (
                  <a href={result.taskUrl} rel="noopener noreferrer" target="_blank">
                    {result.title ?? `Задача ${result.taskId}`}
                  </a>
                ) : (
                  <span>{result.title ?? `Задача ${result.taskId}`}</span>
                )}
                {' — '}
                {outcomeLabels[result.refinement?.outcome ?? result.outcome]}
                {result.reasonMessage ? `: ${result.reasonMessage}` : null}
              </li>
            ))}
          </ul>
        ) : null}
        {nextResultsCursor ? (
          <button
            className="button-secondary"
            disabled={morePending}
            onClick={() => void loadMoreResults()}
            type="button"
          >
            {morePending ? 'Загружаем…' : 'Показать ещё'}
          </button>
        ) : null}
      </Card>
    </div>
  );
}
