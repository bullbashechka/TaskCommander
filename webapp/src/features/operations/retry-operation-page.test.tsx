import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BulkOperationDraft, PreflightPreview } from '@task-commander/contracts';

import {
  AppApiError,
  createTaskPreflight,
  fetchTaskChangeCatalog,
  getBulkOperationDraft,
  prepareRetryOperationDraft,
} from '@/app/app-api';
import { AppAccessProvider, type AppAccessSnapshot } from '@/app/app-context';

import { RetryOperationPage } from './retry-operation-page';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => vi.fn(),
}));
vi.mock('@/app/app-api', async (original) => ({
  ...(await original<typeof import('@/app/app-api')>()),
  createTaskPreflight: vi.fn(),
  fetchTaskChangeCatalog: vi.fn(),
  getBulkOperationDraft: vi.fn(),
  prepareRetryOperationDraft: vi.fn(),
}));
vi.mock('@/features/tasks/preflight-preview', () => ({
  PreflightPreviewScreen: ({ preview }: { preview: PreflightPreview }) => (
    <div>Предпросмотр повтора: {preview.entries.length}</div>
  ),
}));

const sourceId = '323e4567-e89b-42d3-a456-426614174024';
const draft: BulkOperationDraft = {
  id: '123e4567-e89b-42d3-a456-426614174024',
  ownerId: '10',
  revision: 1,
  status: 'preparing',
  filters: [],
  sort: { fieldId: 'deadline', direction: 'asc' },
  selectedTaskIds: ['42'],
  changes: [{ fieldId: 'title', kind: 'text', action: 'set', value: 'Original command' }],
  retrySourceOperationId: sourceId,
  retrySourceStateVersion: 8,
  retryIntents: [{ taskId: '42', targetValues: { title: 'Absolute target' } }],
  createdAt: '2026-09-28T09:00:00Z',
  updatedAt: '2026-09-28T09:00:00Z',
  expiresAt: '2026-09-29T09:00:00Z',
};
const preview: PreflightPreview = {
  draftId: draft.id,
  sourceDraftRevision: 1,
  draftRevision: 2,
  actorAccessVersion: 1,
  checkedAt: '2026-09-28T09:00:00Z',
  canProceed: true,
  entries: [
    {
      taskId: '42',
      title: 'Task',
      taskUrl: null,
      disposition: 'eligible',
      changedFieldIds: ['title'],
      reasonCode: null,
      reasonMessage: null,
      relevantVersion: 'v1',
      currentValues: { title: 'Before' },
      targetValues: { title: 'Absolute target' },
    },
  ],
  summary: {
    selected: 1,
    eligible: 1,
    excluded: 0,
    unchanged: 0,
    successful: 0,
    failed: 0,
    unconfirmed: 0,
    conflicted: 0,
    partiallyApplied: 0,
    notProcessed: 0,
  },
};
const app = {
  generation: 1,
  principal: { portalId: 'portal-1', userId: '10' },
  canMutate: true,
  access: {
    permissions: [
      'app_access',
      'run_bulk_operations',
      'change_allowed_fields',
      'view_own_reports',
      'retry_operations',
    ],
    fieldScope: { kind: 'all' },
  },
} as unknown as AppAccessSnapshot;

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('retry operation page', () => {
  it('can prepare a new retry after the server marks its old draft stale', async () => {
    vi.mocked(getBulkOperationDraft).mockRejectedValueOnce(
      new AppApiError('stale', 'temporary', 409),
    );
    vi.mocked(fetchTaskChangeCatalog).mockResolvedValue({ version: 1, fields: [] });
    vi.mocked(prepareRetryOperationDraft).mockResolvedValue(draft);
    vi.mocked(createTaskPreflight).mockResolvedValue(preview);
    render(
      <AppAccessProvider value={app}>
        <RetryOperationPage operationId={sourceId} />
      </AppAccessProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Подготовить повтор' }));
    expect(await screen.findByText('Предпросмотр повтора: 1')).toBeTruthy();
  });

  it('rereads tasks with a new revision when reopening an awaiting confirmation draft', async () => {
    vi.mocked(getBulkOperationDraft).mockResolvedValue({
      draft: {
        ...draft,
        revision: 2,
        status: 'awaiting_confirmation',
      },
    });
    vi.mocked(fetchTaskChangeCatalog).mockResolvedValue({ version: 1, fields: [] });
    vi.mocked(createTaskPreflight).mockResolvedValue({
      ...preview,
      sourceDraftRevision: 2,
      draftRevision: 3,
    });
    render(
      <AppAccessProvider value={app}>
        <RetryOperationPage operationId={sourceId} />
      </AppAccessProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Проверить повтор заново' }));
    expect(await screen.findByText('Предпросмотр повтора: 1')).toBeTruthy();
    expect(createTaskPreflight).toHaveBeenCalledWith({ draftId: draft.id, expectedRevision: 2 });
  });

  it('ignores an old preparation response after operation and principal change', async () => {
    let releaseOld!: (value: BulkOperationDraft) => void;
    vi.mocked(getBulkOperationDraft)
      .mockResolvedValueOnce({ draft: null })
      .mockResolvedValueOnce({ draft: null });
    vi.mocked(fetchTaskChangeCatalog).mockResolvedValue({ version: 1, fields: [] });
    vi.mocked(prepareRetryOperationDraft).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseOld = resolve;
        }),
    );
    const rendered = render(
      <AppAccessProvider value={app}>
        <RetryOperationPage operationId={sourceId} />
      </AppAccessProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Подготовить повтор' }));
    const nextSourceId = '323e4567-e89b-42d3-a456-426614174025';
    rendered.rerender(
      <AppAccessProvider
        value={{
          ...app,
          generation: 2,
          principal: { ...app.principal, userId: '11' },
        }}
      >
        <RetryOperationPage operationId={nextSourceId} />
      </AppAccessProvider>,
    );
    await act(async () => {
      releaseOld(draft);
    });
    expect(screen.queryByText('Предпросмотр повтора: 1')).toBeNull();
    expect(await screen.findByRole('button', { name: 'Подготовить повтор' })).toBeTruthy();
    expect(createTaskPreflight).not.toHaveBeenCalled();
  });

  it('recovers a committed retry draft after a lost prepare response', async () => {
    vi.mocked(getBulkOperationDraft)
      .mockResolvedValueOnce({ draft: null })
      .mockResolvedValueOnce({ draft });
    vi.mocked(fetchTaskChangeCatalog).mockResolvedValue({ version: 1, fields: [] });
    vi.mocked(prepareRetryOperationDraft).mockRejectedValue(new Error('response lost'));
    vi.mocked(createTaskPreflight).mockResolvedValue(preview);
    render(
      <AppAccessProvider value={app}>
        <RetryOperationPage operationId={sourceId} />
      </AppAccessProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Подготовить повтор' }));
    expect(await screen.findByText('Предпросмотр повтора: 1')).toBeTruthy();
    expect(createTaskPreflight).toHaveBeenCalledWith({ draftId: draft.id, expectedRevision: 1 });
  });

  it('does not replace a different live draft', async () => {
    vi.mocked(getBulkOperationDraft).mockResolvedValue({
      draft: {
        ...draft,
        retrySourceOperationId: '323e4567-e89b-42d3-a456-426614174099',
      },
    });
    vi.mocked(fetchTaskChangeCatalog).mockResolvedValue({ version: 1, fields: [] });
    render(
      <AppAccessProvider value={app}>
        <RetryOperationPage operationId={sourceId} />
      </AppAccessProvider>,
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Подготовить повтор' }).hasAttribute('disabled'),
      ).toBe(true),
    );
    expect(prepareRetryOperationDraft).not.toHaveBeenCalled();
  });
});
