import { describe, expect, it } from 'vitest';

import { mockFixtureIds } from '../src/integrations/bitrix/mock/fixtures';
import { createMockScenario } from '../src/integrations/bitrix/mock/scenario';
import { createMockPortalState } from '../src/integrations/bitrix/mock/state';
import { createMockTasks } from '../src/integrations/bitrix/mock/tasks';

function expectSuccess<T>(result: { ok: true; value: T } | { ok: false }): T {
  if (!result.ok) throw new Error('Expected a successful mock result.');
  return result.value;
}

describe('mock Bitrix task changes', () => {
  it('compares all relevant fields when only one field is written', async () => {
    const state = createMockPortalState();
    const tasks = createMockTasks(state);
    const snapshot = expectSuccess(
      await tasks.readForChange({
        taskId: mockFixtureIds.visibleTask,
        fieldIds: ['title', 'description'],
      }),
    );
    const changedTask = state.getMutableTask(mockFixtureIds.visibleTask);
    if (!changedTask) throw new Error('Visible fixture is unavailable.');
    changedTask.values.description = 'Concurrent edit';
    const result = expectSuccess(
      await tasks.applyChange({
        taskId: snapshot.taskId,
        expectedRelevantVersion: snapshot.relevantVersion,
        relevantFieldIds: ['title', 'description'],
        targetValues: { title: 'New title' },
      }),
    );
    expect(result.kind).toBe('conflict');
  });

  it('includes the paired start date in a deadline write version', async () => {
    const state = createMockPortalState();
    const tasks = createMockTasks(state);
    const snapshot = expectSuccess(
      await tasks.readForChange({
        taskId: mockFixtureIds.visibleTask,
        fieldIds: ['deadline', 'start_date'],
      }),
    );
    const changedTask = state.getMutableTask(mockFixtureIds.visibleTask);
    if (!changedTask) throw new Error('Visible fixture is unavailable.');
    changedTask.values.start_date = '2026-08-11T10:00:00+05:00';
    const result = expectSuccess(
      await tasks.applyChange({
        taskId: snapshot.taskId,
        expectedRelevantVersion: snapshot.relevantVersion,
        relevantFieldIds: ['deadline', 'start_date'],
        targetValues: { deadline: '2026-08-20T10:00:00+05:00' },
      }),
    );
    expect(result.kind).toBe('conflict');
  });

  it('detects a relevant field change as a conflict', async () => {
    const state = createMockPortalState();
    const tasks = createMockTasks(state);
    const snapshot = expectSuccess(
      await tasks.readForChange({ taskId: mockFixtureIds.conflictTask, fieldIds: ['deadline'] }),
    );
    const changedTask = state.getMutableTask(mockFixtureIds.conflictTask);
    if (!changedTask) throw new Error('Conflict fixture is unavailable.');
    changedTask.values.deadline = '2026-08-15T10:00:00+05:00';

    const result = expectSuccess(
      await tasks.applyChange({
        taskId: snapshot.taskId,
        expectedRelevantVersion: snapshot.relevantVersion,
        targetValues: { deadline: '2026-08-20T10:00:00+05:00' },
      }),
    );

    expect(result).toMatchObject({ kind: 'conflict' });
  });

  it('does not treat an unrelated change as a conflict', async () => {
    const state = createMockPortalState();
    const tasks = createMockTasks(state);
    const snapshot = expectSuccess(
      await tasks.readForChange({ taskId: mockFixtureIds.visibleTask, fieldIds: ['deadline'] }),
    );
    const changedTask = state.getMutableTask(mockFixtureIds.visibleTask);
    if (!changedTask) throw new Error('Visible fixture is unavailable.');
    changedTask.values.description = 'Changed by another user.';

    const result = expectSuccess(
      await tasks.applyChange({
        taskId: snapshot.taskId,
        expectedRelevantVersion: snapshot.relevantVersion,
        targetValues: { deadline: '2026-08-20T10:00:00+05:00' },
      }),
    );

    expect(result).toEqual({ kind: 'success', appliedFieldIds: ['deadline'] });
  });

  it('reconciles a lost response with a partially applied outcome', async () => {
    const state = createMockPortalState();
    const tasks = createMockTasks(
      state,
      createMockScenario([
        {
          method: 'tasks.applyChange',
          entityId: mockFixtureIds.partialTask,
          effect: { kind: 'apply_then_drop_response', appliedFieldIds: ['deadline'] },
        },
      ]),
    );
    const snapshot = expectSuccess(
      await tasks.readForChange({
        taskId: mockFixtureIds.partialTask,
        fieldIds: ['deadline', 'priority'],
      }),
    );

    const result = expectSuccess(
      await tasks.applyChange({
        taskId: snapshot.taskId,
        expectedRelevantVersion: snapshot.relevantVersion,
        targetValues: { deadline: '2026-08-20T10:00:00+05:00', priority: 'high' },
      }),
    );

    expect(result).toEqual({
      kind: 'partially_applied',
      appliedFieldIds: ['deadline'],
      failedFieldIds: ['priority'],
    });
  });

  it('returns a typed rate limit without retry orchestration', async () => {
    const tasks = createMockTasks(
      createMockPortalState(),
      createMockScenario([
        {
          method: 'tasks.search',
          effect: {
            kind: 'return_failure',
            failure: { kind: 'rate_limited', limit: 'intensity', retryAt: null },
          },
        },
      ]),
    );

    const result = await tasks.search({
      filters: [],
      sort: { fieldId: 'deadline', direction: 'asc' },
      page: 1,
      pageSize: 50,
    });

    expect(result).toEqual({
      ok: false,
      failure: { kind: 'rate_limited', limit: 'intensity', retryAt: null },
    });
  });

  it('uses one unavailable result for missing and unreadable tasks', async () => {
    const tasks = createMockTasks(createMockPortalState());

    await expect(
      tasks.readForChange({ taskId: '999999', fieldIds: ['deadline'] }),
    ).resolves.toEqual({ ok: false, failure: { kind: 'not_found_or_forbidden' } });
    await expect(
      tasks.readForChange({ taskId: mockFixtureIds.hiddenTask, fieldIds: ['deadline'] }),
    ).resolves.toEqual({
      ok: false,
      failure: { kind: 'not_found_or_forbidden' },
    });
  });

  it('rejects fields without edit rights and parent deadlines managed by subtasks', async () => {
    const tasks = createMockTasks(createMockPortalState());
    const noEditSnapshot = expectSuccess(
      await tasks.readForChange({ taskId: mockFixtureIds.noEditTask, fieldIds: ['deadline'] }),
    );
    const noEditResult = await tasks.applyChange({
      taskId: noEditSnapshot.taskId,
      expectedRelevantVersion: noEditSnapshot.relevantVersion,
      targetValues: { deadline: '2026-08-20T10:00:00+05:00' },
    });
    expect(noEditResult).toEqual({ ok: false, failure: { kind: 'permission_denied' } });

    const controlledSnapshot = expectSuccess(
      await tasks.readForChange({
        taskId: mockFixtureIds.deadlineControlledParent,
        fieldIds: ['deadline'],
      }),
    );
    await expect(
      tasks.applyChange({
        taskId: controlledSnapshot.taskId,
        expectedRelevantVersion: controlledSnapshot.relevantVersion,
        targetValues: { deadline: '2026-08-20T10:00:00+05:00' },
      }),
    ).resolves.toEqual({
      ok: false,
      failure: {
        kind: 'permanent_failure',
        reasonCode: 'deadline_managed_by_subtasks',
        fieldIds: ['deadline'],
      },
    });
  });
});
