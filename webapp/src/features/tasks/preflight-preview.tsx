import { useEffect, useRef, useState } from 'react';

import type {
  PreflightPreview,
  BulkOperation,
  TaskChangeCatalogResponse,
  TaskChangeValue,
  TaskPreflightConfirmation,
} from '@task-commander/contracts';

import {
  AppApiError,
  confirmTaskPreflight,
  launchTaskPreflight,
  retryTaskOperationLaunch,
} from '@/app/app-api';
import { Card } from '@/components/ui/card';
import { Modal } from '@/components/ui/modal';

function displayValue(value: TaskChangeValue | undefined): string {
  if (value === undefined || value === null || value === '') return 'Не заполнено';
  if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : 'Пустой список';
  return String(value);
}

export function PreflightPreviewScreen({
  preview,
  catalog,
  onBack,
  onOperationLaunched,
  canRetryLaunch = false,
}: {
  preview: PreflightPreview;
  catalog: TaskChangeCatalogResponse;
  onBack(): void;
  onOperationLaunched?(operation: BulkOperation): void;
  canRetryLaunch?: boolean;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [confirmation, setConfirmation] = useState<TaskPreflightConfirmation | null>(null);
  const [operation, setOperation] = useState<BulkOperation | null>(null);
  const [zeroAttempted, setZeroAttempted] = useState(false);
  const [zeroConflict, setZeroConflict] = useState(false);
  const [confirmationExpiresAt, setConfirmationExpiresAt] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const requestIdentity = useRef(0);
  const launchInFlight = useRef(false);
  const confirmationRef = useRef<TaskPreflightConfirmation | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousPreview = useRef(preview);
  if (previousPreview.current !== preview) {
    previousPreview.current = preview;
    requestIdentity.current += 1;
  }
  const deadline = Math.min(
    Date.parse(preview.checkedAt) + 900_000,
    confirmationExpiresAt ?? Number.POSITIVE_INFINITY,
  );
  const remainingMinutes = Math.max(0, Math.ceil((deadline - now) / 60_000));
  const fresh = remainingMinutes > 0;
  useEffect(() => {
    setAcknowledged(false);
    setConfirmation(null);
    confirmationRef.current = null;
    setOperation(null);
    setZeroAttempted(false);
    setZeroConflict(false);
    setConfirmationExpiresAt(null);
    setModalOpen(false);
    setError('');
    setPending(false);
  }, [preview]);
  useEffect(() => {
    headingRef.current?.focus();
  }, [preview]);
  useEffect(() => {
    const timeout = window.setTimeout(
      () => {
        setNow(Date.now());
        setAcknowledged(false);
        setModalOpen(false);
        if (!launchInFlight.current && confirmationRef.current === null) {
          requestIdentity.current += 1;
          setPending(false);
        }
      },
      Math.max(0, deadline - Date.now()),
    );
    return () => {
      window.clearTimeout(timeout);
    };
  }, [deadline]);
  useEffect(
    () => () => {
      requestIdentity.current += 1;
    },
    [],
  );
  const fieldLabels = new Map(catalog.fields.map((field) => [field.id, field.label]));

  function clearStaleConfirmation() {
    confirmationRef.current = null;
    setConfirmation(null);
    setConfirmationExpiresAt(null);
    setAcknowledged(false);
    setError(
      'Проверка устарела или черновик изменился. Вернитесь к настройке и проверьте задачи снова.',
    );
  }

  async function launch(token: string | null, identity: number) {
    launchInFlight.current = true;
    try {
      const result = await launchTaskPreflight({
        draftId: preview.draftId,
        draftRevision: preview.draftRevision,
        checkedAt: preview.checkedAt,
        token,
      });
      if (identity === requestIdentity.current) {
        setOperation(result);
        onOperationLaunched?.(result);
        confirmationRef.current = null;
        setConfirmation(null);
        setModalOpen(false);
      }
    } finally {
      launchInFlight.current = false;
    }
  }

  async function confirm() {
    if (!acknowledged || !preview.canProceed || Date.now() >= deadline || pending) return;
    const identity = ++requestIdentity.current;
    setPending(true);
    setError('');
    let confirmed = false;
    try {
      const result = await confirmTaskPreflight({
        draftId: preview.draftId,
        draftRevision: preview.draftRevision,
        checkedAt: preview.checkedAt,
      });
      if (identity !== requestIdentity.current) return;
      const actualDeadline = Math.min(deadline, Date.parse(result.expiresAt));
      setConfirmationExpiresAt(actualDeadline);
      if (Date.now() >= actualDeadline) {
        setAcknowledged(false);
        setModalOpen(false);
        setError('Проверка устарела. Вернитесь к настройке и проверьте задачи снова.');
        return;
      }
      confirmationRef.current = result;
      setConfirmation(result);
      confirmed = true;
      setModalOpen(false);
      await launch(result.token, identity);
    } catch (failure) {
      if (identity !== requestIdentity.current) return;
      setModalOpen(false);
      if (failure instanceof AppApiError && failure.status === 409) {
        clearStaleConfirmation();
        return;
      }
      setAcknowledged(false);
      setError(
        confirmed
          ? 'Подтверждение сохранено, но запуск не завершён. Повторите запуск.'
          : 'Не удалось подтвердить проверку или запустить операцию. Повторите действие.',
      );
    } finally {
      if (identity === requestIdentity.current) setPending(false);
    }
  }

  async function launchWithoutChanges() {
    if (pending || zeroConflict || (!fresh && !zeroAttempted) || preview.canProceed || operation)
      return;
    const identity = ++requestIdentity.current;
    setPending(true);
    setZeroAttempted(true);
    setError('');
    try {
      await launch(null, identity);
    } catch (failure) {
      if (identity !== requestIdentity.current) return;
      if (failure instanceof AppApiError && failure.status === 409) {
        setZeroAttempted(false);
        setZeroConflict(true);
        setError(
          'Проверка устарела или черновик изменился. Вернитесь к настройке и проверьте задачи снова.',
        );
      } else {
        setError('Не удалось сохранить итог. Повторите действие.');
      }
    } finally {
      if (identity === requestIdentity.current) setPending(false);
    }
  }

  async function retryFailedLaunch() {
    if (!canRetryLaunch || !operation || operation.status !== 'launch_failed' || pending) return;
    const identity = ++requestIdentity.current;
    setPending(true);
    setError('');
    try {
      const result = await retryTaskOperationLaunch(operation.id);
      if (identity === requestIdentity.current) setOperation(result);
    } catch {
      if (identity === requestIdentity.current)
        setError('Не удалось повторить запуск. Попробуйте позже.');
    } finally {
      if (identity === requestIdentity.current) setPending(false);
    }
  }

  return (
    <section className="bulk-change-page preflight-preview">
      <nav aria-label="Этапы массового изменения" className="breadcrumbs">
        <span>Выбор задач</span>
        <i>/</i>
        <span>Настройка изменений</span>
        <i>/</i>
        <strong>Проверка</strong>
        <i>/</i>
        <span>Выполнение</span>
      </nav>
      <header className="bulk-change-heading">
        <div>
          <span className="eyebrow">Шаг 3 из 4</span>
          <h1 ref={headingRef} tabIndex={-1}>
            Предварительный просмотр
          </h1>
          <p>
            Данные проверены {new Date(preview.checkedAt).toLocaleString('ru-RU')}.{' '}
            {fresh ? `Осталось не более ${remainingMinutes} мин.` : 'Проверка устарела.'}
          </p>
        </div>
      </header>
      <Card>
        <h2>Результат проверки</h2>
        <p>
          Допущено: {preview.summary.eligible}. Исключено: {preview.summary.excluded}. Изменения не
          требуются: {preview.summary.unchanged}.
        </p>
        {preview.summary.excluded > 0 ? (
          <p role="status">Исключённые задачи не будут изменены.</p>
        ) : null}
        {!preview.canProceed ? <p role="status">Нет задач для изменения.</p> : null}
      </Card>
      <Card className="preflight-entry-list">
        <table>
          <thead>
            <tr>
              <th>Задача</th>
              <th>Результат</th>
              <th>Значения</th>
            </tr>
          </thead>
          <tbody>
            {preview.entries.map((entry) => (
              <tr key={entry.taskId}>
                <th scope="row">
                  {entry.taskUrl ? (
                    <a href={entry.taskUrl} rel="noopener noreferrer" target="_blank">
                      #{entry.taskId} · {entry.title ?? 'Задача'}
                    </a>
                  ) : (
                    <>
                      #{entry.taskId} · {entry.title ?? 'Недоступная задача'}
                    </>
                  )}
                </th>
                <td>
                  {entry.disposition === 'eligible'
                    ? 'Допущена'
                    : entry.disposition === 'no_change'
                      ? 'Изменения не требуются'
                      : `Исключена проверкой: ${entry.reasonMessage ?? 'Причина недоступна'}`}
                </td>
                <td>
                  {entry.currentValues && entry.targetValues ? (
                    <div className="preflight-values">
                      {Object.keys(entry.currentValues).map((fieldId) => (
                        <div key={fieldId}>
                          <strong>{fieldLabels.get(fieldId) ?? fieldId}</strong>
                          <span>Сейчас: {displayValue(entry.currentValues?.[fieldId])}</span>
                          <span>После: {displayValue(entry.targetValues?.[fieldId])}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {error ? (
        <p className="task-inline-error" role="alert">
          {error}
        </p>
      ) : null}
      {operation ? (
        <p role="status">
          {operation.status === 'completed'
            ? 'Изменения не выполнялись.'
            : operation.status === 'launch_failed'
              ? canRetryLaunch
                ? 'Запуск не удался. Операцию можно отправить повторно.'
                : 'Запуск не удался. Повторная отправка недоступна.'
              : 'Операция создана. Проверяем запуск.'}
        </p>
      ) : confirmation ? (
        <p role="status">
          {fresh
            ? `Подтверждение сохранено до ${new Date(confirmation.expiresAt).toLocaleString('ru-RU')}. Запуск можно повторить.`
            : 'Срок подтверждения истёк. Повторный запрос проверит, была ли операция создана.'}
        </p>
      ) : null}
      <footer className="bulk-change-footer">
        <button className="button-secondary" onClick={onBack} type="button">
          Вернуться к настройке
        </button>
        {preview.canProceed ? (
          <label>
            <input
              checked={acknowledged}
              disabled={!fresh || pending || confirmation !== null || operation !== null}
              onChange={(event) => setAcknowledged(event.target.checked)}
              type="checkbox"
            />
            Я проверил изменения и осознанно подтверждаю подготовку операции
          </label>
        ) : null}
        {!preview.canProceed && !operation && !zeroConflict && (fresh || zeroAttempted) ? (
          <button
            className="button-primary"
            disabled={(!fresh && !zeroAttempted) || pending}
            onClick={() => void launchWithoutChanges()}
            type="button"
          >
            Сохранить итог без изменений
          </button>
        ) : null}
        {confirmation && !operation ? (
          <button
            className="button-primary"
            disabled={pending}
            onClick={() => {
              const identity = ++requestIdentity.current;
              setPending(true);
              setError('');
              void launch(confirmation.token, identity)
                .catch((failure: unknown) => {
                  if (identity !== requestIdentity.current) return;
                  if (failure instanceof AppApiError && failure.status === 409) {
                    clearStaleConfirmation();
                  } else {
                    setError('Не удалось запустить операцию. Повторите действие.');
                  }
                })
                .finally(() => {
                  if (identity === requestIdentity.current) setPending(false);
                });
            }}
            type="button"
          >
            Повторить запуск
          </button>
        ) : null}
        {operation?.status === 'launch_failed' && canRetryLaunch ? (
          <button
            className="button-primary"
            disabled={pending}
            onClick={() => void retryFailedLaunch()}
            type="button"
          >
            Повторить отправку
          </button>
        ) : null}
        {preview.canProceed && !confirmation && !operation ? (
          <button
            className="button-primary"
            disabled={
              !preview.canProceed || !fresh || !acknowledged || pending || confirmation !== null
            }
            onClick={() => setModalOpen(true)}
            type="button"
          >
            Подтвердить подготовку
          </button>
        ) : null}
      </footer>
      <Modal
        description={`Допущено ${preview.summary.eligible} задач. Исключено ${preview.summary.excluded}. Проверка действительна ещё не более ${remainingMinutes} мин. После подтверждения начнётся запуск операции.`}
        onClose={() => {
          if (!pending) setModalOpen(false);
        }}
        open={modalOpen}
        title="Подтвердить запуск изменения"
      >
        <div className="dialog-actions">
          <button
            className="button-secondary"
            disabled={pending}
            onClick={() => setModalOpen(false)}
            type="button"
          >
            Отмена
          </button>
          <button
            className="button-primary"
            disabled={pending}
            onClick={() => void confirm()}
            type="button"
          >
            {pending ? 'Запуск…' : 'Подтвердить и запустить'}
          </button>
        </div>
      </Modal>
    </section>
  );
}
