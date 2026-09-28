import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BulkOperationDraft, PreflightPreview } from '@task-commander/contracts';

import {
  createTaskPreflight,
  fetchTaskChangeCatalog,
  getBulkOperationDraft,
  getRestoreSource,
  prepareRestoreOperationDraft,
} from '@/app/app-api';
import { AppAccessProvider, type AppAccessSnapshot } from '@/app/app-context';

import { RestoreOperationPage } from './restore-operation-page';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => vi.fn(),
}));
vi.mock('@/app/app-api', async (original) => ({
  ...(await original<typeof import('@/app/app-api')>()),
  createTaskPreflight: vi.fn(),
  fetchTaskChangeCatalog: vi.fn(),
  getBulkOperationDraft: vi.fn(),
  getRestoreSource: vi.fn(),
  prepareRestoreOperationDraft: vi.fn(),
}));
vi.mock('@/features/tasks/preflight-preview', () => ({
  PreflightPreviewScreen: ({ preview }: { preview: PreflightPreview }) =>
    <div>Предпросмотр восстановления: {preview.entries.length}</div>,
}));

const operationId = '323e4567-e89b-42d3-a456-426614174025';
const source = {
  sourceOperationId: operationId,
  sourceStateVersion: 4,
  tasks: [
    { taskId: '42', title: 'Первая задача', taskUrl: null, appliedFieldIds: ['title'] },
    { taskId: '43', title: 'Вторая задача', taskUrl: null, appliedFieldIds: ['title'] },
  ],
};
const draft = {
  id: '123e4567-e89b-42d3-a456-426614174025', ownerId: '10', revision: 1,
  status: 'preparing', filters: [], sort: { fieldId: 'deadline', direction: 'asc' },
  selectedTaskIds: ['42'], changes: [{ fieldId: 'title', kind: 'text', action: 'clear' }],
  restoreSourceOperationId: operationId, restoreSourceStateVersion: 4,
  restoreIntents: [{ taskId: '42', fieldIds: ['title'], afterVersion: 'mock:2' }],
  createdAt: '2026-09-28T09:00:00Z', updatedAt: '2026-09-28T09:00:00Z',
  expiresAt: '2026-09-29T09:00:00Z',
} as BulkOperationDraft;
const preview = {
  draftId: draft.id, sourceDraftRevision: 1, draftRevision: 2,
  actorAccessVersion: 1, checkedAt: '2026-09-28T09:00:00Z', canProceed: true,
  entries: [{ taskId: '42', title: 'Первая задача', taskUrl: null,
    disposition: 'eligible', changedFieldIds: ['title'], reasonCode: null,
    reasonMessage: null, relevantVersion: 'v2', currentValues: null,
    targetValues: null, valuesOmitted: true }],
  summary: { selected: 1, eligible: 1, excluded: 0, unchanged: 0,
    successful: 0, failed: 0, unconfirmed: 0, conflicted: 0,
    partiallyApplied: 0, notProcessed: 0 },
} as PreflightPreview;
const app = {
  generation: 1, principal: { portalId: 'portal-1', userId: '10' }, canMutate: true,
  access: { permissions: ['app_access', 'run_bulk_operations', 'change_allowed_fields',
    'view_own_reports', 'restore_operations'], fieldScope: { kind: 'all' } },
} as unknown as AppAccessSnapshot;

afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('restore operation page', () => {
  it('submits only the explicitly selected server-eligible tasks and shows a redacted preview', async () => {
    vi.mocked(getRestoreSource).mockResolvedValue(source);
    vi.mocked(fetchTaskChangeCatalog).mockResolvedValue({ version: 1, fields: [] });
    vi.mocked(getBulkOperationDraft).mockResolvedValue({ draft: null });
    vi.mocked(prepareRestoreOperationDraft).mockResolvedValue(draft);
    vi.mocked(createTaskPreflight).mockResolvedValue(preview);
    render(<AppAccessProvider value={app}><RestoreOperationPage operationId={operationId} /></AppAccessProvider>);
    fireEvent.click(await screen.findByRole('checkbox', { name: /Вторая задача/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Проверить восстановление' }));
    expect(await screen.findByText('Предпросмотр восстановления: 1')).toBeTruthy();
    expect(prepareRestoreOperationDraft).toHaveBeenCalledWith(operationId, ['42']);
    expect(createTaskPreflight).toHaveBeenCalledWith({ draftId: draft.id, expectedRevision: 1 });
  });

  it('ignores a late source response after the operation and principal change', async () => {
    let release!: (value: typeof source) => void;
    vi.mocked(getRestoreSource).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }))
      .mockResolvedValueOnce({ ...source, sourceOperationId: '323e4567-e89b-42d3-a456-426614174026', tasks: [] });
    vi.mocked(fetchTaskChangeCatalog).mockResolvedValue({ version: 1, fields: [] });
    vi.mocked(getBulkOperationDraft).mockResolvedValue({ draft: null });
    const rendered = render(<AppAccessProvider value={app}><RestoreOperationPage operationId={operationId} /></AppAccessProvider>);
    rendered.rerender(<AppAccessProvider value={{ ...app, generation: 2,
      principal: { ...app.principal, userId: '11' } }}>
      <RestoreOperationPage operationId="323e4567-e89b-42d3-a456-426614174026" />
    </AppAccessProvider>);
    await act(async () => { release(source); });
    await waitFor(() => expect(screen.getByText('Подходящих задач для восстановления нет.')).toBeTruthy());
    expect(screen.queryByText('Первая задача')).toBeNull();
  });
});
