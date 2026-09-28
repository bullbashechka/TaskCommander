import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OperationProgress, TaskOutcome } from '@task-commander/contracts';

import {
  AppApiError,
  cancelOperation,
  getCurrentOperationProgress,
  getOperationProgress,
  getOperationProgressResults,
  retryTaskOperationLaunch,
} from '@/app/app-api';
import { AppAccessProvider, type AppAccessSnapshot } from '@/app/app-context';

import { OperationProgressPage } from './operation-progress-page';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock('@/app/app-api', async (original) => ({
  ...(await original<typeof import('@/app/app-api')>()),
  getCurrentOperationProgress: vi.fn(),
  getOperationProgress: vi.fn(),
  getOperationProgressResults: vi.fn(),
  cancelOperation: vi.fn(),
  retryTaskOperationLaunch: vi.fn(),
}));

const progress: OperationProgress = {
  operation: {
    id: '323e4567-e89b-42d3-a456-426614174000',
    type: 'bulk_change',
    status: 'running',
    stateVersion: 3,
    launchAttempt: 1,
    initiatorId: '10',
    sourceOperationId: null,
    createdAt: '2026-09-28T00:00:00.000Z',
    startedAt: '2026-09-28T00:00:01.000Z',
    completedAt: null,
    cancelRequestedAt: null,
    interruptionRequestedAt: null,
    interruptionReasonCode: null,
    summary: {
      selected: 5,
      eligible: 3,
      excluded: 1,
      unchanged: 1,
      successful: 1,
      failed: 0,
      unconfirmed: 1,
      conflicted: 0,
      partiallyApplied: 0,
      notProcessed: 0,
    },
  },
  processed: 2,
  remaining: 1,
  percent: 66,
};

const app = {
  generation: 1,
  principal: { portalId: 'portal-1', userId: '10' },
  access: { permissions: ['app_access', 'run_bulk_operations'] },
} as unknown as AppAccessSnapshot;

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
beforeEach(() => {
  vi.mocked(getOperationProgressResults).mockResolvedValue({ items: [], nextCursor: null });
});

describe('operation progress', () => {
  it('restores persisted progress without launching and requests cancellation once', async () => {
    vi.mocked(getCurrentOperationProgress).mockResolvedValue(progress);
    vi.mocked(cancelOperation).mockResolvedValue({
      ...progress,
      operation: {
        ...progress.operation,
        stateVersion: 4,
        cancelRequestedAt: '2026-09-28T00:00:02.000Z',
      },
    });
    render(
      <AppAccessProvider value={app}>
        <OperationProgressPage />
      </AppAccessProvider>,
    );
    expect(await screen.findByText(/Задач с зафиксированным итогом: 2 из 3/)).toBeTruthy();
    expect(screen.getByText('Не подтверждено')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Отменить операцию' }));
    await waitFor(() =>
      expect(screen.getByText('Останавливается после текущей задачи')).toBeTruthy(),
    );
    expect(cancelOperation).toHaveBeenCalledWith(progress.operation.id);
    expect(getOperationProgress).not.toHaveBeenCalled();
  });

  it('clears sensitive progress when access is revoked during refresh', async () => {
    vi.mocked(getOperationProgress).mockRejectedValue(
      new AppApiError('Denied', 'access_denied', 403),
    );
    render(
      <AppAccessProvider value={app}>
        <OperationProgressPage operationId={progress.operation.id} />
      </AppAccessProvider>,
    );
    expect(await screen.findByText('Нет доступа к операции')).toBeTruthy();
    expect(screen.queryByText(/Задач с зафиксированным итогом: 2 из 3/)).toBeNull();
  });

  it('shows an empty state when the owner has no saved operation', async () => {
    vi.mocked(getCurrentOperationProgress).mockResolvedValue(null);
    render(
      <AppAccessProvider value={app}>
        <OperationProgressPage />
      </AppAccessProvider>,
    );
    expect(await screen.findByText('Операций пока нет')).toBeTruthy();
  });

  it('offers a manual refresh when the first read is offline', async () => {
    vi.mocked(getCurrentOperationProgress)
      .mockRejectedValueOnce(new AppApiError('Offline', 'offline'))
      .mockResolvedValueOnce(progress);
    render(
      <AppAccessProvider value={app}>
        <OperationProgressPage />
      </AppAccessProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Повторить загрузку' }));
    expect(await screen.findByText(/Задач с зафиксированным итогом: 2 из 3/)).toBeTruthy();
  });

  it('shows a neutral synchronous result when no task was eligible', async () => {
    vi.mocked(getCurrentOperationProgress).mockResolvedValue({
      operation: {
        ...progress.operation,
        status: 'completed',
        stateVersion: 4,
        summary: {
          ...progress.operation.summary,
          selected: 2,
          eligible: 0,
          successful: 0,
          unconfirmed: 0,
        },
      },
      processed: 0,
      remaining: 0,
      percent: 100,
    });
    render(
      <AppAccessProvider value={app}>
        <OperationProgressPage />
      </AppAccessProvider>,
    );
    expect(
      await screen.findByText('Задач для изменения нет. Изменения не выполнялись.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Отменить операцию' })).toBeNull();
  });

  it('shows bounded recent outcomes and loads untouched tasks after cancellation', async () => {
    const recorded: TaskOutcome = {
      taskId: '42',
      title: 'Проверенная задача',
      taskUrl: 'https://portal.bitrix24.ru/tasks/42',
      outcome: 'success',
      changedFieldIds: ['title'],
      appliedFieldIds: ['title'],
      failedFieldIds: [],
      reasonCode: null,
      reasonMessage: null,
      canRetry: false,
      refinement: null,
    };
    const untouched: TaskOutcome = {
      ...recorded,
      taskId: '43',
      title: null,
      taskUrl: null,
      outcome: 'not_processed',
      appliedFieldIds: [],
      reasonCode: 'CANCELLED',
      reasonMessage: 'Операция остановлена.',
      canRetry: true,
    };
    vi.mocked(getOperationProgress).mockResolvedValue({
      ...progress,
      operation: { ...progress.operation, status: 'cancelled', stateVersion: 4 },
    });
    vi.mocked(getOperationProgressResults)
      .mockResolvedValueOnce({ items: [recorded], nextCursor: 'next-page' })
      .mockResolvedValueOnce({ items: [untouched], nextCursor: null });
    render(
      <AppAccessProvider value={app}>
        <OperationProgressPage operationId={progress.operation.id} />
      </AppAccessProvider>,
    );
    expect(await screen.findByRole('link', { name: 'Проверенная задача' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Показать ещё' }));
    expect(await screen.findByText('Задача 43')).toBeTruthy();
    expect(getOperationProgressResults).toHaveBeenNthCalledWith(
      2,
      progress.operation.id,
      'next-page',
    );
  });

  it('drops the prior feed and late action responses when current switches operations', async () => {
    const next = {
      ...progress,
      operation: { ...progress.operation, id: '323e4567-e89b-42d3-a456-426614174001' },
    };
    const oldResult: TaskOutcome = {
      taskId: '42',
      title: 'Старая задача',
      taskUrl: null,
      outcome: 'success',
      changedFieldIds: ['title'],
      appliedFieldIds: ['title'],
      failedFieldIds: [],
      reasonCode: null,
      reasonMessage: null,
      canRetry: false,
      refinement: null,
    };
    const newResult = { ...oldResult, taskId: '43', title: 'Новая задача' };
    let resolveMore!: (page: { items: TaskOutcome[]; nextCursor: string | null }) => void;
    const more = new Promise<{ items: TaskOutcome[]; nextCursor: string | null }>((resolve) => {
      resolveMore = resolve;
    });
    let resolveCancelA!: (value: OperationProgress) => void;
    const cancelA = new Promise<OperationProgress>((resolve) => {
      resolveCancelA = resolve;
    });
    let resolveCancelB!: (value: OperationProgress) => void;
    const cancelB = new Promise<OperationProgress>((resolve) => {
      resolveCancelB = resolve;
    });
    vi.mocked(getCurrentOperationProgress).mockResolvedValueOnce(progress).mockResolvedValue(next);
    vi.mocked(getOperationProgressResults).mockImplementation(async (id, cursor) => {
      if (cursor) return more;
      return id === progress.operation.id
        ? { items: [oldResult], nextCursor: 'old-cursor' }
        : { items: [newResult], nextCursor: null };
    });
    vi.mocked(cancelOperation).mockReturnValueOnce(cancelA).mockReturnValueOnce(cancelB);
    vi.useFakeTimers();
    try {
      render(
        <AppAccessProvider value={app}>
          <OperationProgressPage />
        </AppAccessProvider>,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText('Старая задача')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Показать ещё' }));
      fireEvent.click(screen.getByRole('button', { name: 'Отменить операцию' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(screen.getByText('Новая задача')).toBeTruthy();
      expect(screen.queryByText('Старая задача')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Отменить операцию' }));
      expect(cancelOperation).toHaveBeenNthCalledWith(2, next.operation.id);
      await act(async () => {
        resolveMore({ items: [oldResult], nextCursor: null });
        resolveCancelA({ ...progress, operation: { ...progress.operation, stateVersion: 4 } });
        await Promise.resolve();
      });
      expect(screen.getByRole('button', { name: 'Отменяем…' }).hasAttribute('disabled')).toBe(true);
      expect(screen.getByText('Новая задача')).toBeTruthy();
      expect(screen.queryByText('Старая задача')).toBeNull();
      await act(async () => {
        resolveCancelB({
          ...next,
          operation: {
            ...next.operation,
            stateVersion: 4,
            cancelRequestedAt: '2026-09-28T00:00:02.000Z',
          },
        });
        await Promise.resolve();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['access_denied', 403, 'Нет доступа к операции'],
    ['session_required', 401, 'Нет доступа к операции'],
    ['internal', 404, 'Операция не найдена'],
  ] as const)(
    'clears prior task titles when a result page returns %s',
    async (kind, status, title) => {
      const result: TaskOutcome = {
        taskId: '42',
        title: 'Секретный заголовок',
        taskUrl: 'https://portal.bitrix24.ru/tasks/42',
        outcome: 'success',
        changedFieldIds: ['title'],
        appliedFieldIds: ['title'],
        failedFieldIds: [],
        reasonCode: null,
        reasonMessage: null,
        canRetry: false,
        refinement: null,
      };
      vi.mocked(getOperationProgress).mockResolvedValue(progress);
      vi.mocked(getOperationProgressResults)
        .mockResolvedValueOnce({ items: [result], nextCursor: 'more' })
        .mockRejectedValueOnce(new AppApiError('Unavailable', kind, status));
      render(
        <AppAccessProvider value={app}>
          <OperationProgressPage operationId={progress.operation.id} />
        </AppAccessProvider>,
      );
      expect(await screen.findByRole('link', { name: 'Секретный заголовок' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Показать ещё' }));
      expect(await screen.findByText(title)).toBeTruthy();
      expect(screen.queryByText('Секретный заголовок')).toBeNull();
      expect(screen.queryByRole('link', { name: 'Секретный заголовок' })).toBeNull();
    },
  );

  it('preserves the retry-launch action after navigation from preview', async () => {
    const retryApp = {
      ...app,
      access: { permissions: ['app_access', 'run_bulk_operations', 'retry_operations'] },
    } as unknown as AppAccessSnapshot;
    const failed = {
      ...progress,
      operation: { ...progress.operation, status: 'launch_failed' as const, stateVersion: 4 },
    };
    vi.mocked(getOperationProgress).mockResolvedValue(failed);
    vi.mocked(retryTaskOperationLaunch).mockResolvedValue({
      ...failed.operation,
      status: 'launching',
      stateVersion: 5,
    });
    render(
      <AppAccessProvider value={retryApp}>
        <OperationProgressPage operationId={failed.operation.id} />
      </AppAccessProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Повторить запуск' }));
    await waitFor(() => expect(screen.getByText('Подготовка запуска')).toBeTruthy());
    expect(retryTaskOperationLaunch).toHaveBeenCalledWith(failed.operation.id);
  });

  it.each([
    ['session_required', 401],
    ['access_denied', 403],
  ] as const)('clears task data when retry launch returns %s', async (kind, status) => {
    const retryApp = {
      ...app,
      access: { permissions: ['app_access', 'run_bulk_operations', 'retry_operations'] },
    } as unknown as AppAccessSnapshot;
    const failed = {
      ...progress,
      operation: { ...progress.operation, status: 'launch_failed' as const },
    };
    const result: TaskOutcome = {
      taskId: '42',
      title: 'Закрытая задача',
      taskUrl: 'https://portal.bitrix24.ru/tasks/42',
      outcome: 'error',
      changedFieldIds: ['title'],
      appliedFieldIds: [],
      failedFieldIds: ['title'],
      reasonCode: 'TASK_WRITE_REJECTED',
      reasonMessage: null,
      canRetry: true,
      refinement: null,
    };
    vi.mocked(getOperationProgress).mockResolvedValue(failed);
    vi.mocked(getOperationProgressResults).mockResolvedValue({ items: [result], nextCursor: null });
    vi.mocked(retryTaskOperationLaunch).mockRejectedValue(new AppApiError('Denied', kind, status));
    render(
      <AppAccessProvider value={retryApp}>
        <OperationProgressPage operationId={failed.operation.id} />
      </AppAccessProvider>,
    );
    expect(await screen.findByRole('link', { name: 'Закрытая задача' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Повторить запуск' }));
    expect(await screen.findByText('Нет доступа к операции')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Закрытая задача' })).toBeNull();
    expect(screen.queryByText('Закрытая задача')).toBeNull();
  });

  it('ignores a late retry-launch response after the current alias selects another operation', async () => {
    const retryApp = {
      ...app,
      access: { permissions: ['app_access', 'run_bulk_operations', 'retry_operations'] },
    } as unknown as AppAccessSnapshot;
    const failed = {
      ...progress,
      operation: { ...progress.operation, status: 'launch_failed' as const },
    };
    const next = {
      ...failed,
      operation: { ...failed.operation, id: '323e4567-e89b-42d3-a456-426614174001' },
    };
    let resolveRetry!: (value: OperationProgress['operation']) => void;
    const retry = new Promise<OperationProgress['operation']>((resolve) => {
      resolveRetry = resolve;
    });
    vi.mocked(getCurrentOperationProgress).mockResolvedValueOnce(failed).mockResolvedValue(next);
    vi.mocked(retryTaskOperationLaunch).mockReturnValue(retry);
    vi.useFakeTimers();
    try {
      render(
        <AppAccessProvider value={retryApp}>
          <OperationProgressPage />
        </AppAccessProvider>,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.click(screen.getByRole('button', { name: 'Повторить запуск' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      await act(async () => {
        resolveRetry({ ...failed.operation, status: 'launching', stateVersion: 4 });
        await Promise.resolve();
      });
      expect(screen.getByText('Не удалось запустить')).toBeTruthy();
      expect(screen.queryByText('Подготовка запуска')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores an older poll that arrives after cancellation', async () => {
    vi.useFakeTimers();
    try {
      let resolveOld!: (value: OperationProgress) => void;
      const old = new Promise<OperationProgress>((resolve) => {
        resolveOld = resolve;
      });
      vi.mocked(getOperationProgress).mockResolvedValueOnce(progress).mockReturnValueOnce(old);
      vi.mocked(cancelOperation).mockResolvedValue({
        ...progress,
        operation: {
          ...progress.operation,
          stateVersion: 4,
          cancelRequestedAt: '2026-09-28T00:00:02.000Z',
        },
      });
      render(
        <AppAccessProvider value={app}>
          <OperationProgressPage operationId={progress.operation.id} />
        </AppAccessProvider>,
      );
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      fireEvent.click(screen.getByRole('button', { name: 'Отменить операцию' }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByText('Останавливается после текущей задачи')).toBeTruthy();
      await act(async () => {
        resolveOld(progress);
        await old;
      });
      expect(screen.getByText('Останавливается после текущей задачи')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
