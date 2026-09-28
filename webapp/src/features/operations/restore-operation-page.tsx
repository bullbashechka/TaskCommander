import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';

import type {
  BulkOperationDraft,
  PreflightPreview,
  TaskChangeCatalogResponse,
} from '@task-commander/contracts';

import { canStartBulkChange } from '@/app/access-policy';
import {
  AppApiError,
  createTaskPreflight,
  fetchTaskChangeCatalog,
  getBulkOperationDraft,
  getRestoreSource,
  prepareRestoreOperationDraft,
} from '@/app/app-api';
import { useAppAccess } from '@/app/app-context';
import { AppState } from '@/components/ui/app-state';
import { Card } from '@/components/ui/card';
import { PreflightPreviewScreen } from '@/features/tasks/preflight-preview';

type Source = Awaited<ReturnType<typeof getRestoreSource>>;

export function RestoreOperationPage({ operationId }: { operationId: string }) {
  const app = useAppAccess();
  const navigate = useNavigate();
  const [source, setSource] = useState<Source | null>(null);
  const [catalog, setCatalog] = useState<TaskChangeCatalogResponse | null>(null);
  const [draft, setDraft] = useState<BulkOperationDraft | null>(null);
  const [preview, setPreview] = useState<PreflightPreview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const epoch = useRef(0);
  const identity = `${app?.generation ?? 0}:${app?.principal.portalId ?? ''}:${app?.principal.userId ?? ''}:${operationId}`;
  const scope = useRef(identity);
  const switched = scope.current !== identity;
  if (switched) {
    scope.current = identity;
    epoch.current += 1;
  }

  useEffect(() => {
    const current = ++epoch.current;
    scope.current = identity;
    setSource(null);
    setCatalog(null);
    setDraft(null);
    setPreview(null);
    setSelected([]);
    setError('');
    setConflict(false);
    setPending(false);
    setLoading(true);
    const controller = new AbortController();
    void Promise.allSettled([
      getRestoreSource(operationId, controller.signal),
      fetchTaskChangeCatalog(controller.signal),
      getBulkOperationDraft(controller.signal),
    ]).then(([sourceResult, catalogResult, draftResult]) => {
      if (epoch.current !== current || scope.current !== identity) return;
      if (sourceResult.status === 'fulfilled') {
        setSource(sourceResult.value);
        setSelected(sourceResult.value.tasks.map((task) => task.taskId));
      } else {
        setError('Источник восстановления недоступен. Проверьте права и срок хранения операции.');
      }
      if (catalogResult.status === 'fulfilled') setCatalog(catalogResult.value);
      else setError('Не удалось загрузить доступные поля. Обновите страницу.');
      if (draftResult.status === 'fulfilled') {
        const existing = draftResult.value.draft;
        if (existing && existing.restoreSourceOperationId !== operationId) setConflict(true);
        else if (existing) {
          setDraft(existing);
          setSelected(existing.selectedTaskIds);
        }
      } else {
        setConflict(true);
        setError('Не удалось проверить текущий черновик. Обновите страницу.');
      }
    }).finally(() => {
      if (epoch.current === current && scope.current === identity) setLoading(false);
    });
    return () => {
      controller.abort();
      epoch.current += 1;
    };
  }, [identity, operationId]);

  function toggle(taskId: string) {
    if (draft || pending) return;
    setSelected((current) => current.includes(taskId)
      ? current.filter((id) => id !== taskId)
      : [...current, taskId]);
  }

  async function prepare() {
    if (pending || conflict || !source || !catalog || selected.length === 0) return;
    const currentScope = scope.current;
    const currentEpoch = ++epoch.current;
    setPending(true);
    setError('');
    try {
      let current = draft;
      if (!current) {
        try {
          current = await prepareRestoreOperationDraft(operationId, selected);
        } catch (failure) {
          if (failure instanceof AppApiError &&
            (failure.kind === 'offline' || failure.kind === 'temporary')) {
            const availability = await getBulkOperationDraft();
            if (availability.draft?.restoreSourceOperationId === operationId &&
              availability.draft.selectedTaskIds.join(',') === selected.join(',')) {
              current = availability.draft;
            }
          }
          if (!current) throw failure;
        }
      }
      if (scope.current !== currentScope || epoch.current !== currentEpoch) return;
      setDraft(current);
      const checked = await createTaskPreflight({
        draftId: current.id,
        expectedRevision: current.revision,
      });
      if (scope.current !== currentScope || epoch.current !== currentEpoch) return;
      setDraft({ ...current, revision: checked.draftRevision, status: 'awaiting_confirmation' });
      setPreview(checked);
    } catch (failure) {
      if (scope.current !== currentScope || epoch.current !== currentEpoch) return;
      if (failure instanceof AppApiError &&
        (failure.status === 409 || failure.kind === 'access_denied' || failure.kind === 'session_required')) {
        setDraft(null);
        setPreview(null);
        setSource(null);
        setError('Источник, права или задача изменились. Обновите страницу и проверьте восстановление заново.');
      } else {
        setError('Не удалось подготовить восстановление. Сохранённый черновик можно проверить повторно.');
      }
    } finally {
      if (scope.current === currentScope && epoch.current === currentEpoch) setPending(false);
    }
  }

  if (!app || !canStartBulkChange(app) || !app.access.permissions.includes('restore_operations') ||
    !app.access.permissions.some((permission) => permission === 'view_own_reports' || permission === 'view_all_reports')) {
    return <div className="page-content"><AppState title="Нет доступа к восстановлению"
      description="Нужны права на запуск, изменение полей, просмотр исходной операции и восстановление." /></div>;
  }
  if (switched || loading) return <div className="page-content"><AppState title="Загружаем восстановление"
    description="Проверяем источник, доступные задачи и текущий черновик." /></div>;
  if (preview && catalog) return <div className="page-content"><PreflightPreviewScreen
    preview={preview} catalog={catalog} mode="restore" onBack={() => setPreview(null)}
    onOperationLaunched={(operation) => void navigate({
      to: '/operations/$operationId', params: { operationId: operation.id },
    })} /></div>;

  return <div className="page-content">
    <nav aria-label="Хлебные крошки" className="breadcrumbs">
      <Link to="/operations/$operationId" params={{ operationId }}>Исходная операция</Link>
      <i>/</i><strong>Восстановление</strong>
    </nav>
    <Card>
      <h1>Восстановить предыдущие значения</h1>
      <p>Выберите задачи. Перед подтверждением система повторно проверит полную версию каждой задачи. Значения скрыты в предварительном просмотре.</p>
      {conflict ? <p role="alert">У вас уже есть другой черновик. Завершите или замените его в разделе задач.</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {source && source.tasks.length === 0 ? <p>Подходящих задач для восстановления нет.</p> : null}
      {source && source.tasks.length > 0 && !draft ? <>
        <button type="button" className="button-secondary" disabled={pending}
          onClick={() => setSelected(source.tasks.map((task) => task.taskId))}>Выбрать все</button>
        <button type="button" className="button-secondary" disabled={pending}
          onClick={() => setSelected([])}>Снять выбор</button>
        <ul>{source.tasks.map((task) => <li key={task.taskId}>
          <label><input type="checkbox" checked={selected.includes(task.taskId)}
            disabled={pending} onChange={() => toggle(task.taskId)} />
            {task.title ?? `Задача ${task.taskId}`} · Поля: {task.appliedFieldIds.join(', ')}
          </label>
        </li>)}</ul>
      </> : null}
      {draft ? <p>Черновик сохранён. Выбор задач зафиксирован; проверку можно повторить.</p> : null}
      {source ? <button type="button" className="button-primary"
        disabled={pending || conflict || !catalog || selected.length === 0}
        onClick={() => void prepare()}>
        {pending ? 'Проверяем задачи…' : draft ? 'Проверить заново' : 'Проверить восстановление'}
      </button> : null}
    </Card>
  </div>;
}
