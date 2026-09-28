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
  prepareRetryOperationDraft,
} from '@/app/app-api';
import { useAppAccess } from '@/app/app-context';
import { AppState } from '@/components/ui/app-state';
import { Card } from '@/components/ui/card';
import { PreflightPreviewScreen } from '@/features/tasks/preflight-preview';

export function RetryOperationPage({ operationId }: { operationId: string }) {
  const app = useAppAccess();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<BulkOperationDraft | null>(null);
  const [catalog, setCatalog] = useState<TaskChangeCatalogResponse | null>(null);
  const [preview, setPreview] = useState<PreflightPreview | null>(null);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const requestId = useRef(0);
  const identity = `${app?.generation ?? 0}:${app?.principal.portalId ?? ''}:${app?.principal.userId ?? ''}:${operationId}`;
  const scope = useRef(identity);
  const switched = scope.current !== identity;
  if (switched) {
    scope.current = identity;
    requestId.current += 1;
  }

  useEffect(() => {
    const currentRequest = ++requestId.current;
    scope.current = identity;
    setDraft(null);
    setPreview(null);
    setCatalog(null);
    setConflict(false);
    setError('');
    setPending(false);
    setLoading(true);
    const controller = new AbortController();
    void Promise.allSettled([
      getBulkOperationDraft(controller.signal),
      fetchTaskChangeCatalog(controller.signal),
    ])
      .then(([draftResult, catalogResult]) => {
        if (requestId.current !== currentRequest) return;
        if (catalogResult?.status === 'fulfilled') setCatalog(catalogResult.value);
        if (draftResult?.status === 'fulfilled') {
          if (
            draftResult.value.draft &&
            draftResult.value.draft.retrySourceOperationId !== operationId
          ) {
            setConflict(true);
          } else {
            setDraft(draftResult.value.draft);
          }
        } else if (
          draftResult?.status === 'rejected' &&
          draftResult.reason instanceof AppApiError &&
          draftResult.reason.status === 409
        ) {
          setError('Прежний черновик повтора устарел. Подготовьте повтор заново.');
        } else {
          setConflict(true);
          setError('Не удалось безопасно проверить текущий черновик. Обновите страницу.');
        }
        if (catalogResult?.status !== 'fulfilled')
          setError('Не удалось загрузить доступные поля. Обновите страницу.');
      })
      .finally(() => {
        if (requestId.current === currentRequest) setLoading(false);
      });
    return () => {
      controller.abort();
      requestId.current += 1;
    };
  }, [identity, operationId]);

  async function prepare() {
    if (pending || !catalog || conflict) return;
    const currentScope = scope.current;
    const currentRequest = ++requestId.current;
    setPending(true);
    setError('');
    try {
      let current = draft;
      if (!current) {
        try {
          current = await prepareRetryOperationDraft(operationId);
        } catch (failure) {
          if (
            failure instanceof AppApiError &&
            failure.status !== 409 &&
            failure.kind !== 'offline' &&
            failure.kind !== 'temporary'
          )
            throw failure;
          // The response may be lost after the server commits the draft.
          const availability = await getBulkOperationDraft();
          if (availability.draft?.retrySourceOperationId !== operationId) throw failure;
          current = availability.draft;
        }
      }
      if (scope.current !== currentScope || requestId.current !== currentRequest) return;
      setDraft(current);
      const next = await createTaskPreflight({
        draftId: current.id,
        expectedRevision: current.revision,
      });
      if (scope.current !== currentScope || requestId.current !== currentRequest) return;
      setPreview(next);
      setDraft({ ...current, revision: next.draftRevision, status: 'awaiting_confirmation' });
    } catch (failure) {
      if (scope.current !== currentScope || requestId.current !== currentRequest) return;
      if (
        failure instanceof AppApiError &&
        (failure.status === 409 || failure.kind === 'access_denied')
      ) {
        setDraft(null);
        setPreview(null);
        setError(
          'Источник, права или черновик изменились. Откройте исходную операцию и проверьте повтор заново.',
        );
      } else {
        setError('Не удалось проверить повтор. Сохранённый черновик можно проверить ещё раз.');
      }
    } finally {
      if (scope.current === currentScope && requestId.current === currentRequest) setPending(false);
    }
  }

  if (
    !app ||
    !canStartBulkChange(app) ||
    !app.access.permissions.includes('retry_operations') ||
    !app.access.permissions.some(
      (permission) => permission === 'view_own_reports' || permission === 'view_all_reports',
    )
  ) {
    return (
      <div className="page-content">
        <AppState
          title="Нет доступа к повтору"
          description="Права на запуск, изменение полей и просмотр исходной операции обязательны."
        />
      </div>
    );
  }
  if (switched || loading)
    return (
      <div className="page-content">
        <AppState title="Загружаем повтор" description="Проверяем черновик и доступные поля." />
      </div>
    );
  if (preview && catalog)
    return (
      <div className="page-content">
        <PreflightPreviewScreen
          preview={preview}
          catalog={catalog}
          onBack={() => setPreview(null)}
          onOperationLaunched={(operation) => {
            void navigate({
              to: '/operations/$operationId',
              params: { operationId: operation.id },
            });
          }}
        />
      </div>
    );
  return (
    <div className="page-content">
      <nav aria-label="Хлебные крошки" className="breadcrumbs">
        <Link to="/operations/$operationId" params={{ operationId }}>
          Исходная операция
        </Link>
        <i>/</i>
        <strong>Повтор</strong>
      </nav>
      <Card>
        <h1>Повторить отдельные задачи</h1>
        <p>
          Повтор использует сохранённые цели исходной операции. Перед подтверждением каждая задача и
          доступные поля проверяются заново. Неподтверждённые относительные изменения не применяются
          повторно вслепую.
        </p>
        {conflict ? (
          <p role="alert">
            У вас уже есть другой черновик. Завершите или замените его в разделе задач.
          </p>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        <button
          type="button"
          className="button-primary"
          disabled={pending || conflict || !catalog}
          onClick={() => void prepare()}
        >
          {pending ? 'Проверяем задачи…' : draft ? 'Проверить повтор заново' : 'Подготовить повтор'}
        </button>
      </Card>
    </div>
  );
}
