import { describe, expect, it } from 'vitest';

import { type BulkOperationDraft } from '@task-commander/contracts';

import { createMockBitrixAdapter } from '../src/integrations/bitrix/mock';
import { mockFixtureIds } from '../src/integrations/bitrix/mock/fixtures';
import { createMockScenario } from '../src/integrations/bitrix/mock/scenario';
import { createTaskChangeCatalog } from '../src/task-changes/catalog';
import { buildTaskPreflight } from '../src/task-changes/preflight';

const portalOrigins = ['https://portal.bitrix24.ru'];

async function setup(changes: BulkOperationDraft['changes'], selectedTaskIds = ['42']) {
  const adapter = createMockBitrixAdapter({ currentUserId: '10' });
  const capabilities = await adapter.tasks.getFieldCapabilities();
  if (!capabilities.ok) throw new Error('Expected mock capabilities.');
  const catalog = createTaskChangeCatalog(capabilities.value, { kind: 'all' });
  const draft: BulkOperationDraft = {
    id: '123e4567-e89b-42d3-a456-426614174000',
    ownerId: '10',
    revision: 2,
    status: 'preparing',
    filters: [],
    sort: { fieldId: 'deadline', direction: 'asc' },
    selectedTaskIds,
    changes,
    createdAt: '2026-09-04T10:00:00Z',
    updatedAt: '2026-09-04T10:00:00Z',
    expiresAt: '2026-09-05T10:00:00Z',
  };
  return { adapter, catalog, draft };
}

describe('task preflight orchestration', () => {
  it('checks absolute retry targets independently for every task', async () => {
    const { adapter, catalog, draft } = await setup(
      [{ fieldId: 'title', kind: 'text', action: 'set', value: 'Original relative metadata' }],
      [mockFixtureIds.visibleTask, mockFixtureIds.subtask],
    );
    draft.retrySourceOperationId = '123e4567-e89b-42d3-a456-426614174099';
    draft.retrySourceStateVersion = 9;
    draft.retryIntents = [
      { taskId: mockFixtureIds.visibleTask, targetValues: { title: 'Retry target one' } },
      { taskId: mockFixtureIds.subtask, targetValues: { title: 'Retry target two' } },
    ];
    const preview = await buildTaskPreflight({
      adapter,
      catalog,
      draft,
      actorAccessVersion: 7,
      trustedPortalOrigins: portalOrigins,
    });
    expect(preview.entries.map((entry) => entry.targetValues?.title)).toEqual([
      'Retry target one',
      'Retry target two',
    ]);
    expect(preview.entries.map((entry) => entry.changedFieldIds)).toEqual([['title'], ['title']]);
  });

  it('classifies an already reached retry target as no change', async () => {
    const { adapter, catalog, draft } = await setup([
      { fieldId: 'title', kind: 'text', action: 'set', value: 'Old relative command' },
    ]);
    draft.retrySourceOperationId = '123e4567-e89b-42d3-a456-426614174099';
    draft.retrySourceStateVersion = 9;
    draft.retryIntents = [
      { taskId: mockFixtureIds.visibleTask, targetValues: { title: 'Fixture visible task' } },
    ];
    const preview = await buildTaskPreflight({
      adapter,
      catalog,
      draft,
      actorAccessVersion: 7,
      trustedPortalOrigins: portalOrigins,
    });
    expect(preview.entries[0]?.disposition).toBe('no_change');
    expect(preview.canProceed).toBe(false);
  });

  it('preserves selection order across eligible, excluded, and no-change tasks', async () => {
    const { adapter, catalog, draft } = await setup(
      [{ fieldId: 'title', kind: 'text', action: 'set', value: 'Fixture visible task' }],
      [mockFixtureIds.visibleTask, mockFixtureIds.hiddenTask, mockFixtureIds.subtask],
    );

    const preview = await buildTaskPreflight({
      adapter,
      catalog,
      draft,
      actorAccessVersion: 7,
      trustedPortalOrigins: portalOrigins,
      now: () => new Date('2026-09-04T11:00:00Z'),
    });

    expect(preview.entries.map((entry) => entry.taskId)).toEqual(['42', '48', '43']);
    expect(preview.entries.map((entry) => entry.disposition)).toEqual([
      'no_change',
      'excluded_by_preflight',
      'eligible',
    ]);
    expect(preview.entries[1]).toMatchObject({
      title: null,
      taskUrl: null,
      reasonCode: 'TASK_UNAVAILABLE',
    });
    expect(preview).toMatchObject({
      draftRevision: 3,
      sourceDraftRevision: 2,
      actorAccessVersion: 7,
      checkedAt: '2026-09-04T11:00:00.000Z',
      canProceed: true,
      summary: { selected: 3, eligible: 1, excluded: 1, unchanged: 1 },
    });
  });

  it('keeps a zero-eligible preflight non-runnable', async () => {
    const { adapter, catalog, draft } = await setup([
      { fieldId: 'title', kind: 'text', action: 'set', value: 'Fixture visible task' },
    ]);

    const preview = await buildTaskPreflight({
      adapter,
      catalog,
      draft,
      actorAccessVersion: 1,
      trustedPortalOrigins: portalOrigins,
    });

    expect(preview.summary).toMatchObject({ eligible: 0, excluded: 0, unchanged: 1 });
    expect(preview.canProceed).toBe(false);
  });

  it.each([mockFixtureIds.templateTask, mockFixtureIds.recurrenceRuleTask])(
    'keeps non-task entity %s outside the mutable set',
    async (taskId) => {
      const { adapter, catalog, draft } = await setup(
        [{ fieldId: 'title', kind: 'text', action: 'set', value: 'Updated' }],
        [taskId],
      );

      const preview = await buildTaskPreflight({
        adapter,
        catalog,
        draft,
        actorAccessVersion: 1,
        trustedPortalOrigins: portalOrigins,
      });

      expect(preview.entries[0]).toMatchObject({
        title: null,
        taskUrl: null,
        disposition: 'excluded_by_preflight',
        reasonCode: 'TASK_UNAVAILABLE',
      });
      expect(preview.canProceed).toBe(false);
    },
  );

  it('excludes the whole task when one requested field is not editable', async () => {
    const { adapter, catalog, draft } = await setup(
      [{ fieldId: 'title', kind: 'text', action: 'set', value: 'Updated' }],
      [mockFixtureIds.noEditTask],
    );

    const preview = await buildTaskPreflight({
      adapter,
      catalog,
      draft,
      actorAccessVersion: 1,
      trustedPortalOrigins: portalOrigins,
    });

    expect(preview.entries[0]).toMatchObject({
      disposition: 'excluded_by_preflight',
      reasonCode: 'FIELD_NOT_EDITABLE',
      changedFieldIds: [],
    });
  });

  it('checks known Bitrix deadline constraints only when the deadline changes', async () => {
    const { adapter, catalog, draft } = await setup(
      [
        {
          fieldId: 'deadline',
          kind: 'date_time',
          action: 'set',
          value: '2026-09-20T10:00:00+05:00',
        },
      ],
      [mockFixtureIds.deadlineControlledParent],
    );

    const preview = await buildTaskPreflight({
      adapter,
      catalog,
      draft,
      actorAccessVersion: 1,
      trustedPortalOrigins: portalOrigins,
    });

    expect(preview.entries[0]).toMatchObject({
      disposition: 'excluded_by_preflight',
      reasonCode: 'DEADLINE_MANAGED_BY_SUBTASKS',
      relevantVersion: expect.any(String),
    });
  });

  it('excludes a task whose changed participant target is inactive', async () => {
    const { adapter, catalog, draft } = await setup([
      { fieldId: 'responsible_id', kind: 'user', action: 'set', value: '99' },
    ]);

    const preview = await buildTaskPreflight({
      adapter,
      catalog,
      draft,
      actorAccessVersion: 1,
      trustedPortalOrigins: portalOrigins,
    });

    expect(preview.entries[0]).toMatchObject({
      disposition: 'excluded_by_preflight',
      reasonCode: 'RELATED_USER_UNAVAILABLE',
      currentValues: { responsible_id: '10' },
      targetValues: { responsible_id: '99' },
    });
  });

  it('checks an unchanged participant in the full target when another field changes', async () => {
    const scenario = createMockScenario([
      {
        method: 'tasks.readForChange',
        entityId: mockFixtureIds.visibleTask,
        effect: {
          kind: 'mutate_task',
          taskId: mockFixtureIds.visibleTask,
          patch: { values: { responsible_id: '99' } },
        },
      },
    ]);
    const adapter = createMockBitrixAdapter({ currentUserId: '10', scenario });
    const capabilities = await adapter.tasks.getFieldCapabilities();
    if (!capabilities.ok) throw new Error('Expected mock capabilities.');
    const catalog = createTaskChangeCatalog(capabilities.value, { kind: 'all' });
    const { draft } = await setup([
      { fieldId: 'title', kind: 'text', action: 'set', value: 'Updated' },
      { fieldId: 'responsible_id', kind: 'user', action: 'set', value: '99' },
    ]);

    const preview = await buildTaskPreflight({
      adapter,
      catalog,
      draft,
      actorAccessVersion: 1,
      trustedPortalOrigins: portalOrigins,
    });

    expect(preview.entries[0]).toMatchObject({
      disposition: 'excluded_by_preflight',
      reasonCode: 'RELATED_USER_UNAVAILABLE',
    });
  });

  it('excludes an unavailable target project', async () => {
    const { adapter, catalog, draft } = await setup([
      { fieldId: 'group_id', kind: 'list', action: 'set', value: '999' },
    ]);

    const preview = await buildTaskPreflight({
      adapter,
      catalog,
      draft,
      actorAccessVersion: 1,
      trustedPortalOrigins: portalOrigins,
    });

    expect(preview.entries[0]).toMatchObject({
      disposition: 'excluded_by_preflight',
      reasonCode: 'RELATED_PROJECT_UNAVAILABLE',
    });
  });

  it('checks the calculated start and deadline combination', async () => {
    const { adapter, catalog, draft } = await setup([
      {
        fieldId: 'start_date',
        kind: 'date_time',
        action: 'set',
        value: '2026-08-20T10:00:00+05:00',
      },
    ]);

    const preview = await buildTaskPreflight({
      adapter,
      catalog,
      draft,
      actorAccessVersion: 1,
      trustedPortalOrigins: portalOrigins,
    });

    expect(preview.entries[0]).toMatchObject({
      disposition: 'excluded_by_preflight',
      reasonCode: 'INVALID_FIELD_COMBINATION',
    });
  });

  it('uses the portal calendar for relative dates and stores absolute target values', async () => {
    const { adapter, catalog, draft } = await setup([
      {
        fieldId: 'deadline',
        kind: 'date_time',
        action: 'shift',
        direction: 'forward',
        days: 1,
        calendar: 'working_days',
      },
    ]);

    const preview = await buildTaskPreflight({
      adapter,
      catalog,
      draft,
      actorAccessVersion: 1,
      trustedPortalOrigins: portalOrigins,
    });

    expect(preview.entries[0]).toMatchObject({
      disposition: 'eligible',
      currentValues: { deadline: '2026-08-14T10:00:00+05:00' },
      targetValues: { deadline: '2026-08-17T05:00:00.000Z' },
    });
  });

  it.each([
    {
      failure: { kind: 'rate_limited' as const, limit: 'intensity' as const, retryAt: null },
      code: 'RATE_LIMITED',
    },
    {
      failure: { kind: 'temporary_failure' as const, reasonCode: 'network' },
      code: 'UPSTREAM_UNAVAILABLE',
    },
  ])('does not persist a deceptively narrowed result after $code', async ({ failure, code }) => {
    const scenario = createMockScenario([
      {
        method: 'tasks.readForChange',
        entityId: mockFixtureIds.visibleTask,
        effect: { kind: 'return_failure', failure },
      },
    ]);
    const adapter = createMockBitrixAdapter({ currentUserId: '10', scenario });
    const capabilities = await adapter.tasks.getFieldCapabilities();
    if (!capabilities.ok) throw new Error('Expected mock capabilities.');
    const catalog = createTaskChangeCatalog(capabilities.value, { kind: 'all' });
    const { draft } = await setup(
      [{ fieldId: 'title', kind: 'text', action: 'set', value: 'Updated' }],
      [mockFixtureIds.visibleTask, mockFixtureIds.subtask],
    );

    await expect(
      buildTaskPreflight({
        adapter,
        catalog,
        draft,
        actorAccessVersion: 1,
        trustedPortalOrigins: portalOrigins,
      }),
    ).rejects.toMatchObject({ code });
  });

  it('rejects an oversized aggregate snapshot while task reads are still in progress', async () => {
    const selectedTaskIds = Array.from({ length: 8 }, (_, index) => String(1_000 + index));
    const {
      adapter: baseAdapter,
      catalog,
      draft,
    } = await setup(
      [{ fieldId: 'tags', kind: 'tags', action: 'replace', values: ['updated'] }],
      selectedTaskIds,
    );
    const largeTags = Array.from({ length: 256 }, (_, index) => `${index}-${'x'.repeat(4_080)}`);
    const adapter = {
      ...baseAdapter,
      tasks: {
        ...baseAdapter.tasks,
        readForChange: async ({ taskId }: { taskId: string }) => ({
          ok: true as const,
          value: {
            taskId,
            title: 'Large task',
            taskUrl: `https://portal.bitrix24.ru/tasks/${taskId}`,
            status: 'in_progress' as const,
            values: { tags: largeTags },
            editableFieldIds: ['tags'],
            isTemplate: false,
            isRecurrenceRule: false,
            deadlineManagedBySubtasks: false,
            relevantVersion: `version-${taskId}`,
          },
        }),
      },
    };

    await expect(
      buildTaskPreflight({
        adapter,
        catalog,
        draft,
        actorAccessVersion: 1,
        trustedPortalOrigins: portalOrigins,
      }),
    ).rejects.toMatchObject({ code: 'PREFLIGHT_TOO_LARGE' });
  });
});
