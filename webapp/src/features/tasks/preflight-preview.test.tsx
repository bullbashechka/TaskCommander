import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PreflightPreview, TaskChangeCatalogResponse } from '@task-commander/contracts';

import { confirmTaskPreflight } from '@/app/app-api';

import { PreflightPreviewScreen } from './preflight-preview';

vi.mock('@/app/app-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/app-api')>()),
  confirmTaskPreflight: vi.fn(),
}));

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
  vi.clearAllMocks();
});

describe('preflight preview', () => {
  it('shows calculated values, exclusions and gates confirmation behind checkbox and modal', async () => {
    vi.mocked(confirmTaskPreflight).mockResolvedValue({
      draftId: preview.draftId,
      draftRevision: preview.draftRevision,
      token: '223e4567-e89b-42d3-a456-426614174000',
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    });
    render(<PreflightPreviewScreen catalog={catalog} onBack={vi.fn()} preview={preview} />);
    expect(screen.getByText('Сейчас: Старое')).toBeTruthy();
    expect(screen.getByText('После: Новое')).toBeTruthy();
    expect(screen.getByText(/Исключена проверкой: Задача недоступна/)).toBeTruthy();
    const launch = screen.getByRole('button', { name: 'Подтвердить подготовку' });
    expect(launch.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(launch);
    expect(confirmTaskPreflight).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить подтверждение' }));
    await waitFor(() =>
      expect(confirmTaskPreflight).toHaveBeenCalledWith({
        draftId: preview.draftId,
        draftRevision: preview.draftRevision,
        checkedAt: preview.checkedAt,
      }),
    );
    expect(screen.getByText(/Задачи ещё не изменены/)).toBeTruthy();
    expect(launch.hasAttribute('disabled')).toBe(true);
  });

  it('blocks confirmation when no task can change', () => {
    const empty = {
      ...preview,
      canProceed: false,
      entries: preview.entries.slice(1),
      summary: { ...preview.summary, selected: 1, eligible: 0 },
    };
    render(<PreflightPreviewScreen catalog={catalog} onBack={vi.fn()} preview={empty} />);
    expect(
      screen.getByRole('button', { name: 'Подтвердить подготовку' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(screen.getByText('Нет задач для изменения.')).toBeTruthy();
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
