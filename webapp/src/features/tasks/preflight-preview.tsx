import { useEffect, useRef, useState } from 'react';

import type {
  PreflightPreview,
  TaskChangeCatalogResponse,
  TaskChangeValue,
  TaskPreflightConfirmation,
} from '@task-commander/contracts';

import { AppApiError, confirmTaskPreflight } from '@/app/app-api';
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
}: {
  preview: PreflightPreview;
  catalog: TaskChangeCatalogResponse;
  onBack(): void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [confirmation, setConfirmation] = useState<TaskPreflightConfirmation | null>(null);
  const [confirmationExpiresAt, setConfirmationExpiresAt] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const requestIdentity = useRef(0);
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
        requestIdentity.current += 1;
        setNow(Date.now());
        setAcknowledged(false);
        setConfirmation(null);
        setModalOpen(false);
        setPending(false);
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

  async function confirm() {
    if (!acknowledged || !preview.canProceed || Date.now() >= deadline || pending) return;
    const identity = ++requestIdentity.current;
    setPending(true);
    setError('');
    try {
      const result = await confirmTaskPreflight({
        draftId: preview.draftId,
        draftRevision: preview.draftRevision,
        checkedAt: preview.checkedAt,
      });
      if (identity !== requestIdentity.current) return;
      const actualDeadline = Math.min(deadline, Date.parse(result.expiresAt));
      setConfirmationExpiresAt(actualDeadline);
      if (Date.now() >= actualDeadline) return;
      setConfirmation(result);
      setModalOpen(false);
    } catch (failure) {
      if (identity !== requestIdentity.current) return;
      setAcknowledged(false);
      setModalOpen(false);
      setError(
        failure instanceof AppApiError && failure.status === 409
          ? 'Проверка устарела или черновик изменился. Вернитесь к настройке и проверьте задачи снова.'
          : 'Не удалось подтвердить проверку. Повторите действие.',
      );
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
      {confirmation ? (
        <p role="status">
          Подтверждение сохранено до {new Date(confirmation.expiresAt).toLocaleString('ru-RU')}.
          Задачи ещё не изменены.
        </p>
      ) : null}
      <footer className="bulk-change-footer">
        <button className="button-secondary" onClick={onBack} type="button">
          Вернуться к настройке
        </button>
        <label>
          <input
            checked={acknowledged}
            disabled={!preview.canProceed || !fresh || pending || confirmation !== null}
            onChange={(event) => setAcknowledged(event.target.checked)}
            type="checkbox"
          />
          Я проверил изменения и осознанно подтверждаю подготовку операции
        </label>
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
      </footer>
      <Modal
        description={`Допущено ${preview.summary.eligible} задач. Исключено ${preview.summary.excluded}. Проверка действительна ещё не более ${remainingMinutes} мин. Подтверждение сохранит подготовленный набор; задачи пока не изменятся.`}
        onClose={() => {
          if (!pending) setModalOpen(false);
        }}
        open={modalOpen}
        title="Подтвердить подготовку изменения"
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
            {pending ? 'Подтверждение…' : 'Сохранить подтверждение'}
          </button>
        </div>
      </Modal>
    </section>
  );
}
