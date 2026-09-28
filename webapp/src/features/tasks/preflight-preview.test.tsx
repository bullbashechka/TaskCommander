import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  BulkOperation,
  PreflightPreview,
  TaskChangeCatalogResponse,
} from '@task-commander/contracts';

import {
  AppApiError,
  confirmTaskPreflight,
  launchTaskPreflight,
  retryTaskOperationLaunch,
} from '@/app/app-api';

import { PreflightPreviewScreen } from './preflight-preview';

vi.mock('@/app/app-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/app-api')>()),
  confirmTaskPreflight: vi.fn(),
  launchTaskPreflight: vi.fn(),
  retryTaskOperationLaunch: vi.fn(),
}));

const launchedOperation: BulkOperation = {
  id: '323e4567-e89b-42d3-a456-426614174000',
  type: 'bulk_change',
  status: 'launching',
  stateVersion: 1,
  launchAttempt: 1,
  initiatorId: '10',
  sourceOperationId: null,
  createdAt: new Date().toISOString(),
  startedAt: null,
  completedAt: null,
  cancelRequestedAt: null,
  interruptionRequestedAt: null,
  interruptionReasonCode: null,
  summary: {
    selected: 2,
    eligible: 1,
    excluded: 1,
    unchanged: 0,
    successful: 0,
    failed: 0,
    unconfirmed: 0,
    conflicted: 0,
    partiallyApplied: 0,
    notProcessed: 0,
  },
};

const preview: PreflightPreview = {
  draftId: '123e4567-e89b-42d3-a456-426614174000',
  draftRevision: 4,
  sourceDraftRevision: 3,
  actorAccessVersion: 1,
  checkedAt: new Date().toISOString(),
  canProceed: true,
  entries: [
    {
      taskId: '42',
      title: 'Задача',
      taskUrl: 'https://portal.bitrix24.ru/workgroups/group/1/tasks/task/view/42/',
      disposition: 'eligible',
      changedFieldIds: ['title'],
      reasonCode: null,
      reasonMessage: null,
      relevantVersion: 'v1',
      currentValues: { title: 'Старое' },
      targetValues: { title: 'Новое' },
    },
    {
      taskId: '43',
      title: null,
      taskUrl: null,
      disposition: 'excluded_by_preflight',
      changedFieldIds: [],
      reasonCode: 'TASK_UNAVAILABLE',
      reasonMessage: 'Задача недоступна.',
      relevantVersion: null,
      currentValues: null,
      targetValues: null,
    },
  ],
  summary: {
    selected: 2,
    eligible: 1,
    excluded: 1,
    unchanged: 0,
    successful: 0,
    failed: 0,
    unconfirmed: 0,
    conflicted: 0,
    partiallyApplied: 0,
    notProcessed: 0,
  },
};

const catalog: TaskChangeCatalogResponse = {
  version: 1,
  fields: [
    {
      id: 'title',
      label: 'Название',
      kind: 'text',
      isMultiple: false,
      isNullable: false,
      valueSource: 'text',
      options: [],
      actions: ['set'],
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('preflight preview', () => {
  it('shows calculated values, exclusions and gates confirmation behind checkbox and modal', async () => {
    vi.mocked(confirmTaskPreflight).mockResolvedValue({
      draftId: preview.draftId,
      draftRevision: preview.draftRevision,
      token: '223e4567-e89b-42d3-a456-426614174000',
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    });
    vi.mocked(launchTaskPreflight).mockResolvedValue(launchedOperation);
    render(<PreflightPreviewScreen catalog={catalog} onBack={vi.fn()} preview={preview} />);
    expect(screen.getByText('Сейчас: Старое')).toBeTruthy();
    expect(screen.getByText('После: Новое')).toBeTruthy();
    expect(screen.getByText(/Исключена проверкой: Задача недоступна/)).toBeTruthy();
    const launch = screen.getByRole('button', { name: 'Подтвердить подготовку' });
    expect(launch.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(launch);
    expect(confirmTaskPreflight).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить и запустить' }));
    await waitFor(() =>
      expect(confirmTaskPreflight).toHaveBeenCalledWith({
        draftId: preview.draftId,
        draftRevision: preview.draftRevision,
        checkedAt: preview.checkedAt,
      }),
    );
    await waitFor(() =>
      expect(launchTaskPreflight).toHaveBeenCalledWith({
        draftId: preview.draftId,
        draftRevision: preview.draftRevision,
        checkedAt: preview.checkedAt,
        token: '223e4567-e89b-42d3-a456-426614174000',
      }),
    );
    await waitFor(() => expect(screen.getByText(/Операция создана/)).toBeTruthy());
    expect(launch.hasAttribute('disabled')).toBe(true);
  });

  it('creates a neutral completed result when no task can change', async () => {
    const empty = {
      ...preview,
      canProceed: false,
      entries: preview.entries.slice(1),
      summary: { ...preview.summary, selected: 1, eligible: 0 },
    };
    render(<PreflightPreviewScreen catalog={catalog} onBack={vi.fn()} preview={empty} />);
    vi.mocked(launchTaskPreflight).mockResolvedValue({
      ...launchedOperation,
      status: 'completed',
      summary: { ...launchedOperation.summary, selected: 1, eligible: 0, excluded: 1 },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить итог без изменений' }));
    await waitFor(() =>
      expect(launchTaskPreflight).toHaveBeenCalledWith({
        draftId: empty.draftId,
        draftRevision: empty.draftRevision,
        checkedAt: empty.checkedAt,
        token: null,
      }),
    );
    expect(confirmTaskPreflight).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText('Изменения не выполнялись.')).toBeTruthy());
    expect(screen.getByText('Нет задач для изменения.')).toBeTruthy();
  });

  it('stops zero-result replay after an expired request returns conflict', async () => {
    const currentTime = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(currentTime);
    let rejectLaunch: (reason?: unknown) => void = () => undefined;
    const empty = {
      ...preview,
      checkedAt: new Date(currentTime - 899_500).toISOString(),
      canProceed: false,
      entries: preview.entries.slice(1),
      summary: { ...preview.summary, selected: 1, eligible: 0 },
    };
    vi.mocked(launchTaskPreflight)
      .mockReturnValueOnce(
        new Promise<BulkOperation>((_resolve, reject) => {
          rejectLaunch = reject;
        }),
      )
      .mockRejectedValueOnce(new AppApiError('Conflict', 'internal', 409, 'CONFLICT'));
    try {
      render(<PreflightPreviewScreen catalog={catalog} onBack={vi.fn()} preview={empty} />);
      fireEvent.click(screen.getByRole('button', { name: 'Сохранить итог без изменений' }));
      act(() => vi.advanceTimersByTime(501));
      await act(async () => {
        rejectLaunch(new Error('response lost'));
        await Promise.resolve();
      });
      const retry = screen.getByRole('button', { name: 'Сохранить итог без изменений' });
      expect(retry.hasAttribute('disabled')).toBe(false);
      await act(async () => {
        fireEvent.click(retry);
        await Promise.resolve();
      });
      expect(launchTaskPreflight).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole('button', { name: 'Сохранить итог без изменений' })).toBeNull();
      expect(screen.getByRole('alert').textContent).toContain('проверьте задачи снова');
    } finally {
      vi.useRealTimers();
    }
  });

  it('replays the same token after a lost launch response', async () => {
    vi.mocked(confirmTaskPreflight).mockResolvedValue({
      draftId: preview.draftId,
      draftRevision: preview.draftRevision,
      token: '223e4567-e89b-42d3-a456-426614174000',
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    });
    vi.mocked(launchTaskPreflight)
      .mockRejectedValueOnce(new Error('Lost response'))
      .mockResolvedValueOnce(launchedOperation);
    render(<PreflightPreviewScreen catalog={catalog} onBack={vi.fn()} preview={preview} />);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить подготовку' }));
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить и запустить' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Повторить запуск' })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Повторить запуск' }));
    await waitFor(() => expect(launchTaskPreflight).toHaveBeenCalledTimes(2));
    expect(vi.mocked(launchTaskPreflight).mock.calls[0]?.[0].token).toBe(
      vi.mocked(launchTaskPreflight).mock.calls[1]?.[0].token,
    );
    await waitFor(() => expect(screen.getByText(/Операция создана/)).toBeTruthy());
  });

  it('offers controlled retry only with retry permission and keeps the operation ID', async () => {
    vi.mocked(confirmTaskPreflight).mockResolvedValue({
      draftId: preview.draftId,
      draftRevision: preview.draftRevision,
      token: '223e4567-e89b-42d3-a456-426614174000',
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    });
    vi.mocked(launchTaskPreflight).mockResolvedValue({
      ...launchedOperation,
      status: 'launch_failed',
    });
    vi.mocked(retryTaskOperationLaunch).mockResolvedValue({
      ...launchedOperation,
      launchAttempt: 2,
    });
    render(
      <PreflightPreviewScreen
        canRetryLaunch
        catalog={catalog}
        onBack={vi.fn()}
        preview={preview}
      />,
    );
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить подготовку' }));
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить и запустить' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Повторить отправку' })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Повторить отправку' }));
    await waitFor(() =>
      expect(retryTaskOperationLaunch).toHaveBeenCalledWith(launchedOperation.id),
    );
    expect(screen.getByText(/Операция создана/)).toBeTruthy();
  });

  it('does not promise another send without retry permission', async () => {
    vi.mocked(confirmTaskPreflight).mockResolvedValue({
      draftId: preview.draftId,
      draftRevision: preview.draftRevision,
      token: '223e4567-e89b-42d3-a456-426614174000',
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    });
    vi.mocked(launchTaskPreflight).mockResolvedValue({
      ...launchedOperation,
      status: 'launch_failed',
    });
    render(<PreflightPreviewScreen catalog={catalog} onBack={vi.fn()} preview={preview} />);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить подготовку' }));
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить и запустить' }));
    await waitFor(() =>
      expect(screen.getByText('Запуск не удался. Повторная отправка недоступна.')).toBeTruthy(),
    );
    expect(screen.queryByRole('button', { name: 'Повторить отправку' })).toBeNull();
  });

  it('keeps an in-flight launch result when the preview deadline passes', async () => {
    const currentTime = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(currentTime);
    let resolveLaunch: (value: BulkOperation) => void = () => undefined;
    vi.mocked(confirmTaskPreflight).mockResolvedValue({
      draftId: preview.draftId,
      draftRevision: preview.draftRevision,
      token: '223e4567-e89b-42d3-a456-426614174000',
      expiresAt: new Date(currentTime + 500).toISOString(),
    });
    vi.mocked(launchTaskPreflight).mockReturnValue(
      new Promise((resolve) => {
        resolveLaunch = resolve;
      }),
    );
    try {
      render(
        <PreflightPreviewScreen
          catalog={catalog}
          onBack={vi.fn()}
          preview={{ ...preview, checkedAt: new Date(currentTime - 899_500).toISOString() }}
        />,
      );
      fireEvent.click(screen.getByRole('checkbox'));
      fireEvent.click(screen.getByRole('button', { name: 'Подтвердить подготовку' }));
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Подтвердить и запустить' }));
        await Promise.resolve();
      });
      act(() => vi.advanceTimersByTime(501));
      await act(async () => {
        resolveLaunch(launchedOperation);
        await Promise.resolve();
      });
      expect(screen.getByText(/Операция создана/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('replays a lost launch response after confirmation expiry with the same token', async () => {
    const currentTime = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(currentTime);
    let rejectLaunch: (reason?: unknown) => void = () => undefined;
    vi.mocked(confirmTaskPreflight).mockResolvedValue({
      draftId: preview.draftId,
      draftRevision: preview.draftRevision,
      token: '223e4567-e89b-42d3-a456-426614174000',
      expiresAt: new Date(currentTime + 500).toISOString(),
    });
    vi.mocked(launchTaskPreflight)
      .mockReturnValueOnce(
        new Promise<BulkOperation>((_resolve, reject) => {
          rejectLaunch = reject;
        }),
      )
      .mockResolvedValueOnce(launchedOperation);
    try {
      render(
        <PreflightPreviewScreen
          catalog={catalog}
          onBack={vi.fn()}
          preview={{ ...preview, checkedAt: new Date(currentTime - 899_500).toISOString() }}
        />,
      );
      fireEvent.click(screen.getByRole('checkbox'));
      fireEvent.click(screen.getByRole('button', { name: 'Подтвердить подготовку' }));
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Подтвердить и запустить' }));
        await Promise.resolve();
      });
      act(() => vi.advanceTimersByTime(501));
      await act(async () => {
        rejectLaunch(new Error('response lost'));
        await Promise.resolve();
      });
      const retry = screen.getByRole('button', { name: 'Повторить запуск' });
      expect(retry.hasAttribute('disabled')).toBe(false);
      await act(async () => {
        fireEvent.click(retry);
        await Promise.resolve();
      });
      expect(launchTaskPreflight).toHaveBeenCalledTimes(2);
      expect(vi.mocked(launchTaskPreflight).mock.calls[0]?.[0].token).toBe(
        vi.mocked(launchTaskPreflight).mock.calls[1]?.[0].token,
      );
      expect(screen.getByText(/Операция создана/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears an expired token when exact replay returns conflict', async () => {
    const currentTime = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(currentTime);
    vi.mocked(confirmTaskPreflight).mockResolvedValue({
      draftId: preview.draftId,
      draftRevision: preview.draftRevision,
      token: '223e4567-e89b-42d3-a456-426614174000',
      expiresAt: new Date(currentTime + 500).toISOString(),
    });
    vi.mocked(launchTaskPreflight)
      .mockRejectedValueOnce(new Error('response lost'))
      .mockRejectedValueOnce(new AppApiError('Conflict', 'internal', 409, 'CONFLICT'));
    try {
      render(
        <PreflightPreviewScreen
          catalog={catalog}
          onBack={vi.fn()}
          preview={{ ...preview, checkedAt: new Date(currentTime - 899_500).toISOString() }}
        />,
      );
      fireEvent.click(screen.getByRole('checkbox'));
      fireEvent.click(screen.getByRole('button', { name: 'Подтвердить подготовку' }));
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Подтвердить и запустить' }));
        await Promise.resolve();
      });
      act(() => vi.advanceTimersByTime(501));
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Повторить запуск' }));
        await Promise.resolve();
      });
      expect(screen.queryByRole('button', { name: 'Повторить запуск' })).toBeNull();
      expect(screen.getByRole('alert').textContent).toContain('проверьте задачи снова');
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears acknowledgement at the exact preview deadline', () => {
    const currentTime = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(currentTime);
    try {
      render(
        <PreflightPreviewScreen
          catalog={catalog}
          onBack={vi.fn()}
          preview={{ ...preview, checkedAt: new Date(currentTime - 899_000).toISOString() }}
        />,
      );
      fireEvent.click(screen.getByRole('checkbox'));
      expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
      act(() => vi.advanceTimersByTime(1_001));
      expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
      expect(
        screen.getByRole('button', { name: 'Подтвердить подготовку' }).hasAttribute('disabled'),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
