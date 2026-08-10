import { describe, expect, it } from 'vitest';

import { createMockPortalState } from '../src/integrations/bitrix/mock/state';
import { mockFixtureIds } from '../src/integrations/bitrix/mock/fixtures';
import { createMockTasks } from '../src/integrations/bitrix/mock/tasks';

function expectSuccess<T>(result: { ok: true; value: T } | { ok: false }): T {
  if (!result.ok) {
    throw new Error('Expected a successful mock result.');
  }

  return result.value;
}

describe('mock Bitrix task catalog', () => {
  it(
    'returns ordinary tasks, subtasks and recurring instances but excludes templates and completed tasks',
    async () => {
      const tasks = createMockTasks(createMockPortalState());
      const page = expectSuccess(
        await tasks.search({
          filters: [
            {
              kind: 'text',
              fieldId: 'title',
              operator: 'contains',
              values: ['fixture'],
            },
          ],
          sort: { fieldId: 'title', direction: 'asc' },
          page: 1,
          pageSize: 50,
        }),
      );

      const ids = page.items.map((task) => task.id);
      expect(ids).toContain(mockFixtureIds.visibleTask);
      expect(ids).toContain(mockFixtureIds.subtask);
      expect(ids).toContain(mockFixtureIds.recurringInstance);
      expect(ids).not.toContain(mockFixtureIds.completedTask);
      expect(ids).not.toContain(mockFixtureIds.templateTask);
      expect(ids).not.toContain(mockFixtureIds.recurrenceRuleTask);
      expect(ids).not.toContain(mockFixtureIds.hiddenTask);
    },
  );

  it('marks an unknown external field type as unsupported', async () => {
    const tasks = createMockTasks(createMockPortalState());
    const capabilities = expectSuccess(await tasks.getFieldCapabilities());
    const unsupported = capabilities.find((field) => field.id === 'crm_binding');

    expect(unsupported).toMatchObject({ kind: null, isEditable: true, isSupported: false });
  });

  it('serves a 100,000-task portal without pre-materializing task objects', async () => {
    const state = createMockPortalState({ taskCount: 100_000 });
    const tasks = createMockTasks(state);
    const page = expectSuccess(
      await tasks.search({
        filters: [],
        sort: { fieldId: 'deadline', direction: 'asc' },
        page: 1,
        pageSize: 50,
      }),
    );

    expect(page.items).toHaveLength(50);
    expect(page.total).toBeGreaterThanOrEqual(100_000);
    expect(state.taskOverrides.size).toBe(0);
  });
});
