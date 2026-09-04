import { describe, expect, it } from 'vitest';

import { createMockPortalState } from '../src/integrations/bitrix/mock/state';
import { mockFixtureIds } from '../src/integrations/bitrix/mock/fixtures';
import { createMockScenario } from '../src/integrations/bitrix/mock/scenario';
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

  it.each([
    ['empty', 0, 'empty', 0],
    ['at the selection limit', 993, 'selected', 1_000],
    ['above the selection limit', 994, 'too_many', 1_001],
  ] as const)('resolves select-all %s atomically', async (_name, taskCount, kind, total) => {
    const resolution = expectSuccess(
      await createMockTasks(createMockPortalState({ taskCount })).selectAll({
        filters:
          taskCount === 0
            ? [
                {
                  kind: 'text',
                  fieldId: 'title',
                  operator: 'contains',
                  values: ['not-present-in-any-task'],
                },
              ]
            : [],
        sort: { fieldId: 'deadline', direction: 'asc' },
      }),
    );

    expect(resolution).toMatchObject({ kind, total });
    if (resolution.kind === 'selected') {
      expect(resolution.taskIds).toHaveLength(total);
      expect(new Set(resolution.taskIds).size).toBe(total);
    }
  });

  it('selects only readable unfinished tasks and preserves recurring instances', async () => {
    const resolution = expectSuccess(
      await createMockTasks(createMockPortalState({ taskCount: 0 })).selectAll({
        filters: [],
        sort: { fieldId: 'deadline', direction: 'asc' },
      }),
    );

    expect(resolution.kind).toBe('selected');
    if (resolution.kind === 'selected') {
      expect(resolution.taskIds).toContain(mockFixtureIds.recurringInstance);
      expect(resolution.taskIds).not.toContain(mockFixtureIds.completedTask);
      expect(resolution.taskIds).not.toContain(mockFixtureIds.templateTask);
      expect(resolution.taskIds).not.toContain(mockFixtureIds.recurrenceRuleTask);
      expect(resolution.taskIds).not.toContain(mockFixtureIds.hiddenTask);
    }
  });

  it('resolves the filtered selection against one current mock state', async () => {
    const state = createMockPortalState({ taskCount: 0 });
    const tasks = createMockTasks(
      state,
      createMockScenario([
        {
          method: 'tasks.selectAll',
          effect: {
            kind: 'mutate_task',
            taskId: mockFixtureIds.visibleTask,
            patch: { values: { priority: 'high' } },
          },
        },
      ]),
    );

    const resolution = expectSuccess(
      await tasks.selectAll({
        filters: [{ kind: 'list', fieldId: 'priority', operator: 'equals', values: ['high'] }],
        sort: { fieldId: 'deadline', direction: 'asc' },
      }),
    );

    expect(resolution.kind).toBe('selected');
    if (resolution.kind === 'selected') {
      expect(resolution.taskIds).toContain(mockFixtureIds.visibleTask);
    }
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
    expect(operatorPage.items.every((task) => task.groupId !== null)).toBe(true);
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

  it('combines conditions for different fields with AND semantics', async () => {
    const state = createMockPortalState({ taskCount: 0 });
    const matching = state.getMutableTask(mockFixtureIds.visibleTask);
    const priorityOnly = state.getMutableTask(mockFixtureIds.noEditTask);
    if (!matching || !priorityOnly) throw new Error('Expected task fixtures.');
    matching.values.priority = 'high';
    priorityOnly.title = 'Other priority task';
    priorityOnly.values.title = priorityOnly.title;
    priorityOnly.values.priority = 'high';

    const page = expectSuccess(
      await createMockTasks(state).search({
        filters: [
          { kind: 'text', fieldId: 'title', operator: 'contains', values: ['Fixture'] },
          { kind: 'list', fieldId: 'priority', operator: 'equals', values: ['high'] },
        ],
        sort: { fieldId: 'title', direction: 'asc' },
        page: 1,
        pageSize: 50,
      }),
    );

    expect(page.items.map((task) => task.id)).toEqual([matching.id]);
  });

  it('filters number and boolean custom fields', async () => {
    const state = createMockPortalState({ taskCount: 0 });
    const matching = state.getMutableTask(mockFixtureIds.visibleTask);
    if (!matching) throw new Error('Expected visible task fixture.');
    matching.values.UF_TASK_EFFORT = 12;
    matching.values.UF_TASK_APPROVED = true;

    const page = expectSuccess(
      await createMockTasks(state).search({
        filters: [
          {
            kind: 'number',
            fieldId: 'UF_TASK_EFFORT',
            operator: 'greater_than',
            values: [10],
          },
          {
            kind: 'boolean',
            fieldId: 'UF_TASK_APPROVED',
            operator: 'equals',
            values: [true],
          },
        ],
        sort: { fieldId: 'UF_TASK_EFFORT', direction: 'desc' },
        page: 1,
        pageSize: 50,
      }),
    );

    expect(page.items.map((task) => task.id)).toEqual([matching.id]);
  });

  it('implements date, presence, and negative operator semantics', async () => {
    const state = createMockPortalState({ taskCount: 0 });
    const target = state.getMutableTask(mockFixtureIds.visibleTask);
    const counterexample = state.getMutableTask(mockFixtureIds.subtask);
    if (!target || !counterexample) throw new Error('Expected task fixtures.');
    const tasks = createMockTasks(state);
    const filters = [
      {
        kind: 'date_time' as const,
        fieldId: 'deadline',
        operator: 'equals' as const,
        values: ['2026-08-14T05:00:00Z'],
      },
      {
        kind: 'date_time' as const,
        fieldId: 'deadline',
        operator: 'before' as const,
        values: ['2026-08-15T00:00:00Z'],
      },
      {
        kind: 'date_time' as const,
        fieldId: 'deadline',
        operator: 'after' as const,
        values: ['2026-08-13T00:00:00Z'],
      },
      {
        kind: 'date_time' as const,
        fieldId: 'deadline',
        operator: 'between' as const,
        values: ['2026-08-14T04:00:00Z', '2026-08-14T06:00:00Z'],
      },
      {
        kind: 'text' as const,
        fieldId: 'title',
        operator: 'not_contains' as const,
        values: ['absent'],
      },
      {
        kind: 'list' as const,
        fieldId: 'priority',
        operator: 'not_equals' as const,
        values: ['high'],
      },
      {
        kind: 'user' as const,
        fieldId: 'accomplice_ids',
        operator: 'not_includes' as const,
        values: ['99'],
      },
      {
        kind: 'text' as const,
        fieldId: 'description',
        operator: 'is_set' as const,
      },
    ];

    for (const filter of filters) {
      if (filter.fieldId === 'deadline') {
        counterexample.values.deadline =
          filter.operator === 'after'
            ? '2026-08-12T00:00:00Z'
            : '2026-08-16T00:00:00Z';
      } else if (filter.fieldId === 'title') {
        counterexample.title = 'Fixture absent task';
        counterexample.values.title = 'Fixture absent task';
      } else if (filter.fieldId === 'priority') {
        counterexample.values.priority = 'high';
      } else if (filter.fieldId === 'accomplice_ids') {
        counterexample.values.accomplice_ids = ['99'];
      } else if (filter.fieldId === 'description') {
        counterexample.values.description = null;
      }
      const page = expectSuccess(
        await tasks.search({
          filters: [filter],
          sort: { fieldId: 'title', direction: 'asc' },
          page: 1,
          pageSize: 50,
        }),
      );
      expect(page.items.map((task) => task.id)).toContain(target.id);
      expect(page.items.map((task) => task.id)).not.toContain(counterexample.id);
    }

    target.values.deadline = null;
    counterexample.values.deadline = '2026-08-16T00:00:00Z';
    const unsetPage = expectSuccess(
      await tasks.search({
        filters: [{ kind: 'date_time', fieldId: 'deadline', operator: 'is_not_set' }],
        sort: { fieldId: 'title', direction: 'asc' },
        page: 1,
        pageSize: 50,
      }),
    );
    expect(unsetPage.items.map((task) => task.id)).toContain(target.id);
    expect(unsetPage.items.map((task) => task.id)).not.toContain(counterexample.id);
  });

  it('distinguishes OR membership from exact equality for multiple fields', async () => {
    const state = createMockPortalState({ taskCount: 0 });
    const oneMember = state.getMutableTask(mockFixtureIds.visibleTask);
    const twoMembers = state.getMutableTask(mockFixtureIds.subtask);
    if (!oneMember || !twoMembers) throw new Error('Expected task fixtures.');
    oneMember.values.accomplice_ids = ['11'];
    twoMembers.values.accomplice_ids = ['11', '12'];
    const tasks = createMockTasks(state);

    const exact = expectSuccess(
      await tasks.search({
        filters: [
          {
            kind: 'user',
            fieldId: 'accomplice_ids',
            operator: 'equals',
            values: ['11'],
          },
        ],
        sort: { fieldId: 'title', direction: 'asc' },
        page: 1,
        pageSize: 50,
      }),
    );
    const membership = expectSuccess(
      await tasks.search({
        filters: [
          {
            kind: 'user',
            fieldId: 'accomplice_ids',
            operator: 'includes',
            values: ['12', '99'],
          },
        ],
        sort: { fieldId: 'title', direction: 'asc' },
        page: 1,
        pageSize: 50,
      }),
    );

    expect(exact.items.some((task) => task.id === oneMember.id)).toBe(true);
    expect(exact.items.some((task) => task.id === twoMembers.id)).toBe(false);
    expect(membership.items.some((task) => task.id === twoMembers.id)).toBe(true);
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
