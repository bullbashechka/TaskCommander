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

  it('serves a 100,000-task portal without populating mutable override storage', async () => {
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

  it('uses native readability for each current user', async () => {
    const operatorPage = expectSuccess(
      await createMockTasks(createMockPortalState({ currentUserId: '10', taskCount: 0 })).search({
        filters: [],
        sort: { fieldId: 'title', direction: 'asc' },
        page: 1,
        pageSize: 50,
      }),
    );
    const administratorPage = expectSuccess(
      await createMockTasks(createMockPortalState({ currentUserId: '1', taskCount: 0 })).search({
        filters: [],
        sort: { fieldId: 'title', direction: 'asc' },
        page: 1,
        pageSize: 50,
      }),
    );

    expect(operatorPage.items.some((task) => task.id === mockFixtureIds.hiddenTask)).toBe(false);
    expect(operatorPage.items.every((task) => task.taskUrl.includes('/user/10/'))).toBe(true);
    expect(
      administratorPage.items.some((task) => task.id === mockFixtureIds.hiddenTask),
    ).toBe(true);
  });

  it('combines multiple selected values of one field with OR semantics', async () => {
    const page = expectSuccess(
      await createMockTasks(createMockPortalState({ taskCount: 10 })).search({
        filters: [
          {
            kind: 'user',
            fieldId: 'responsible_id',
            operator: 'equals',
            values: ['10', '11'],
          },
        ],
        sort: { fieldId: 'responsible_id', direction: 'asc' },
        page: 1,
        pageSize: 50,
      }),
    );

    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((task) => ['10', '11'].includes(task.responsibleId))).toBe(true);
    expect(new Set(page.items.map((task) => task.responsibleId))).toEqual(new Set(['10', '11']));
  });

  it('sorts date-time fields by instant and keeps null values last', async () => {
    const state = createMockPortalState({ taskCount: 0 });
    const later = state.getMutableTask(mockFixtureIds.visibleTask);
    const earlier = state.getMutableTask(mockFixtureIds.subtask);
    const withoutDeadline = state.getMutableTask(mockFixtureIds.recurringInstance);
    if (!later || !earlier || !withoutDeadline) throw new Error('Expected task fixtures.');
    later.values.deadline = '2026-09-01T01:00:00-10:00';
    earlier.values.deadline = '2026-09-01T10:00:00+05:00';
    withoutDeadline.values.deadline = null;

    const page = expectSuccess(
      await createMockTasks(state).search({
        filters: [
          { kind: 'text', fieldId: 'title', operator: 'contains', values: ['Fixture'] },
        ],
        sort: { fieldId: 'deadline', direction: 'asc' },
        page: 1,
        pageSize: 50,
      }),
    );

    expect(page.items.indexOf(page.items.find((task) => task.id === earlier.id)!)).toBeLessThan(
      page.items.indexOf(page.items.find((task) => task.id === later.id)!),
    );
    expect(page.items.at(-1)?.id).toBe(withoutDeadline.id);

    const descendingPage = expectSuccess(
      await createMockTasks(state).search({
        filters: [
          { kind: 'text', fieldId: 'title', operator: 'contains', values: ['Fixture'] },
        ],
        sort: { fieldId: 'deadline', direction: 'desc' },
        page: 1,
        pageSize: 50,
      }),
    );
    expect(
      descendingPage.items.indexOf(descendingPage.items.find((task) => task.id === later.id)!),
    ).toBeLessThan(
      descendingPage.items.indexOf(descendingPage.items.find((task) => task.id === earlier.id)!),
    );
    expect(descendingPage.items.at(-1)?.id).toBe(withoutDeadline.id);
  });

  it('uses exact numeric task IDs as a stable tie-breaker across pages', async () => {
    const state = createMockPortalState({ taskCount: 100 });
    const firstFixture = state.getMutableTask(mockFixtureIds.visibleTask);
    const secondFixture = state.getMutableTask(mockFixtureIds.subtask);
    if (!firstFixture || !secondFixture) throw new Error('Expected task fixtures.');
    firstFixture.id = '9007199254740993';
    secondFixture.id = '9007199254740992';
    firstFixture.title = 'Equal title';
    secondFixture.title = 'Equal title';
    firstFixture.values.title = 'Equal title';
    secondFixture.values.title = 'Equal title';

    const tasks = createMockTasks(state);
    const request = {
      filters: [],
      sort: { fieldId: 'title', direction: 'asc' as const },
      pageSize: 50,
    };
    const firstPage = expectSuccess(await tasks.search({ ...request, page: 1 }));
    const secondPage = expectSuccess(await tasks.search({ ...request, page: 2 }));
    const repeatedFirstPage = expectSuccess(await tasks.search({ ...request, page: 1 }));
    const repeatedSecondPage = expectSuccess(await tasks.search({ ...request, page: 2 }));
    const ids = [...firstPage.items, ...secondPage.items].map((task) => task.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.indexOf(secondFixture.id)).toBeLessThan(ids.indexOf(firstFixture.id));
    expect(repeatedFirstPage.items.map((task) => task.id)).toEqual(
      firstPage.items.map((task) => task.id),
    );
    expect(repeatedSecondPage.items.map((task) => task.id)).toEqual(
      secondPage.items.map((task) => task.id),
    );
  });

  it('returns a control version that changes with relevant task state', async () => {
    const state = createMockPortalState({ taskCount: 0 });
    const tasks = createMockTasks(state);
    const request = {
      filters: [
        {
          kind: 'text' as const,
          fieldId: 'title',
          operator: 'equals' as const,
          values: ['Fixture visible task'],
        },
      ],
      sort: { fieldId: 'deadline', direction: 'asc' as const },
      page: 1,
      pageSize: 50,
    };
    const before = expectSuccess(await tasks.search(request)).items[0];
    const mutable = state.getMutableTask(mockFixtureIds.visibleTask);
    if (!before || !mutable) throw new Error('Expected visible task fixture.');
    mutable.values.deadline = '2026-10-01T10:00:00+05:00';
    const after = expectSuccess(await tasks.search(request)).items[0];

    expect(after?.relevantVersion).not.toBe(before.relevantVersion);
  });
});
