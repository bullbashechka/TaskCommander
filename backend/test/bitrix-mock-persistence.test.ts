import { describe, expect, it } from 'vitest';

import { createMockBitrixAdapter } from '../src/integrations/bitrix/mock';
import type { MockTask } from '../src/integrations/bitrix/mock/fixtures';
import type { MockTaskPersistence } from '../src/integrations/bitrix/mock/persistence';
import { createMockScenario } from '../src/integrations/bitrix/mock/scenario';

function durableMockTasks(): MockTaskPersistence {
  const saved = new Map<string, { task: MockTask; mutationVersion: number }>();
  return {
    async read(taskId) {
      return saved.get(taskId) ?? null;
    },
    async list() {
      return [...saved.values()];
    },
    async mutate(task, expectedMutationVersion) {
      const currentVersion = saved.get(task.id)?.mutationVersion ?? 0;
      if (currentVersion !== expectedMutationVersion) return null;
      const nextVersion = currentVersion + 1;
      saved.set(task.id, { task, mutationVersion: nextVersion });
      return nextVersion;
    },
    async apply({ taskId, baseTask, targetValues, executionFence }) {
      const existing = saved.get(taskId);
      const version = existing?.mutationVersion ?? 0;
      if (version !== executionFence.expectedMutationVersion) return { kind: 'conflict' };
      const task = existing?.task ?? baseTask;
      const nextVersion = version + 1;
      saved.set(taskId, {
        task: {
          ...task,
          title: typeof targetValues.title === 'string' ? targetValues.title : task.title,
          values: { ...task.values, ...targetValues },
        },
        mutationVersion: nextVersion,
      });
      return {
        kind: 'success',
        appliedFieldIds: Object.keys(targetValues),
        afterMutationVersion: nextVersion,
      };
    },
  };
}

describe('durable local mock task boundary', () => {
  it('exposes a consumer write to a new API adapter and increments the full-task version', async () => {
    const persistence = durableMockTasks();
    const first = createMockBitrixAdapter({
      currentUserId: '10',
      taskCount: 0,
      taskPersistence: persistence,
    });
    const before = await first.tasks.readForChange({ taskId: '42', fieldIds: ['title'] });
    if (!before.ok || before.value.mutationVersion === undefined)
      throw new Error('Missing initial snapshot.');
    expect(before.value.mutationVersion).toBe(0);
    const written = await first.tasks.applyChange({
      taskId: '42',
      expectedRelevantVersion: before.value.relevantVersion,
      targetValues: { title: 'Changed' },
      executionFence: {
        portalId: 'test',
        operationId: '123e4567-e89b-42d3-a456-426614174001',
        launchAttempt: 1,
        claimId: '123e4567-e89b-42d3-a456-426614174002',
        expectedMutationVersion: 0,
      },
    });
    expect(written).toMatchObject({
      ok: true,
      value: { kind: 'success', afterMutationVersion: 1 },
    });

    const second = createMockBitrixAdapter({
      currentUserId: '10',
      taskCount: 0,
      taskPersistence: persistence,
    });
    const after = await second.tasks.readForChange({ taskId: '42', fieldIds: ['title'] });
    expect(after).toMatchObject({
      ok: true,
      value: {
        values: { title: 'Changed' },
        mutationVersion: 1,
      },
    });
    if (!after.ok) throw new Error('Missing persisted snapshot.');
    const beforeUnrelated = await second.tasks.readForChange({
      taskId: '42',
      fieldIds: ['description'],
    });
    if (!beforeUnrelated.ok) throw new Error('Missing description snapshot.');
    const unrelated = await second.tasks.applyChange({
      taskId: '42',
      expectedRelevantVersion: beforeUnrelated.value.relevantVersion,
      targetValues: { description: 'Unrelated' },
      executionFence: {
        portalId: 'test',
        operationId: '123e4567-e89b-42d3-a456-426614174001',
        launchAttempt: 1,
        claimId: '123e4567-e89b-42d3-a456-426614174003',
        expectedMutationVersion: 1,
      },
    });
    expect(unrelated).toMatchObject({ ok: true, value: { afterMutationVersion: 2 } });
    const third = createMockBitrixAdapter({
      currentUserId: '10',
      taskCount: 0,
      taskPersistence: persistence,
    });
    const final = await third.tasks.readForChange({ taskId: '42', fieldIds: ['title'] });
    expect(final).toMatchObject({ ok: true, value: { mutationVersion: 2 } });
    if (final.ok) expect(final.value.relevantVersion).toBe(after.value.relevantVersion);
  });

  it('preserves an applied write after its response is lost across adapter instances', async () => {
    const persistence = durableMockTasks();
    const first = createMockBitrixAdapter({
      currentUserId: '10',
      taskCount: 0,
      taskPersistence: persistence,
      scenario: createMockScenario([
        {
          method: 'tasks.applyChange',
          entityId: '42',
          effect: { kind: 'apply_then_drop_response', appliedFieldIds: ['title'] },
        },
      ]),
    });
    const before = await first.tasks.readForChange({ taskId: '42', fieldIds: ['title'] });
    if (!before.ok) throw new Error('Missing initial snapshot.');
    const response = await first.tasks.applyChange({
      taskId: '42',
      expectedRelevantVersion: before.value.relevantVersion,
      targetValues: { title: 'After lost response' },
      executionFence: {
        portalId: 'test',
        operationId: '123e4567-e89b-42d3-a456-426614174001',
        launchAttempt: 1,
        claimId: '123e4567-e89b-42d3-a456-426614174002',
        expectedMutationVersion: 0,
      },
    });
    expect(response).toMatchObject({ ok: false, failure: { kind: 'temporary_failure' } });
    const second = createMockBitrixAdapter({
      currentUserId: '10',
      taskCount: 0,
      taskPersistence: persistence,
    });
    expect(await second.tasks.readForChange({ taskId: '42', fieldIds: ['title'] })).toMatchObject({
      ok: true,
      value: { values: { title: 'After lost response' }, mutationVersion: 1 },
    });
  });

  it('persists an external scenario mutation and advances the full-task version', async () => {
    const persistence = durableMockTasks();
    const first = createMockBitrixAdapter({
      currentUserId: '10',
      taskCount: 0,
      taskPersistence: persistence,
      scenario: createMockScenario([
        {
          method: 'tasks.readForChange',
          entityId: '42',
          effect: {
            kind: 'mutate_task',
            taskId: '42',
            patch: { values: { description: 'External' } },
          },
        },
      ]),
    });
    const firstRead = await first.tasks.readForChange({ taskId: '42', fieldIds: ['title'] });
    expect(firstRead).toMatchObject({ ok: true, value: { mutationVersion: 1 } });
    const second = createMockBitrixAdapter({
      currentUserId: '10',
      taskCount: 0,
      taskPersistence: persistence,
    });
    const secondRead = await second.tasks.readForChange({ taskId: '42', fieldIds: ['title'] });
    expect(secondRead).toMatchObject({ ok: true, value: { mutationVersion: 1 } });
    if (firstRead.ok && secondRead.ok)
      expect(secondRead.value.relevantVersion).toBe(firstRead.value.relevantVersion);
  });
});
