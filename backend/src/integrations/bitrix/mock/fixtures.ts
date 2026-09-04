export const mockFixtureIds = {
  visibleTask: '42',
  subtask: '43',
  recurringInstance: '44',
  completedTask: '45',
  templateTask: '46',
  recurrenceRuleTask: '47',
  hiddenTask: '48',
  noEditTask: '49',
  deadlineControlledParent: '50',
  conflictTask: '51',
  partialTask: '52',
} as const;

export type MockTaskStatus =
  | 'pending'
  | 'in_progress'
  | 'pending_review'
  | 'deferred'
  | 'completed';

export interface MockTask {
  id: string;
  title: string;
  parentId: string | null;
  status: MockTaskStatus;
  isTemplate: boolean;
  isRecurrenceRule: boolean;
  isRecurringInstance: boolean;
  deleted: boolean;
  readableBy: readonly string[];
  editableFieldIdsByUser: Readonly<Record<string, readonly string[]>>;
  deadlineManagedBySubtasks: boolean;
  values: Record<string, string | number | boolean | null | string[]>;
}

const editableFields = [
  'title',
  'description',
  'creator_id',
  'responsible_id',
  'accomplice_ids',
  'auditor_ids',
  'deadline',
  'start_date',
  'priority',
  'status',
  'group_id',
  'tags',
  'UF_TASK_EFFORT',
  'UF_TASK_APPROVED',
];

function createFixture(
  id: string,
  title: string,
  overrides: Partial<MockTask> = {},
): MockTask {
  const { values: valueOverrides, ...taskOverrides } = overrides;
  const values = {
    title,
    description: `Description for ${title}`,
    creator_id: '1',
    responsible_id: '10',
    accomplice_ids: ['11'],
    auditor_ids: ['12'],
    deadline: '2026-08-14T10:00:00+05:00',
    start_date: '2026-08-10T10:00:00+05:00',
    priority: 'normal',
    status: 'in_progress',
    group_id: '1',
    tags: ['fixture'],
    UF_TASK_EFFORT: 8,
    UF_TASK_APPROVED: false,
    ...valueOverrides,
  };

  return {
    id,
    title,
    parentId: null,
    status: 'in_progress',
    isTemplate: false,
    isRecurrenceRule: false,
    isRecurringInstance: false,
    deleted: false,
    readableBy: ['10', '1'],
    editableFieldIdsByUser: { '10': editableFields, '1': editableFields },
    deadlineManagedBySubtasks: false,
    values,
    ...taskOverrides,
  };
}

export function createMockTaskFixtures(): readonly MockTask[] {
  return [
    createFixture(mockFixtureIds.visibleTask, 'Fixture visible task'),
    createFixture(mockFixtureIds.subtask, 'Fixture subtask', {
      parentId: mockFixtureIds.deadlineControlledParent,
    }),
    createFixture(mockFixtureIds.recurringInstance, 'Fixture recurring instance', {
      isRecurringInstance: true,
    }),
    createFixture(mockFixtureIds.completedTask, 'Fixture completed task', {
      status: 'completed',
      values: { status: 'completed' },
    }),
    createFixture(mockFixtureIds.templateTask, 'Fixture template task', { isTemplate: true }),
    createFixture(mockFixtureIds.recurrenceRuleTask, 'Fixture recurrence rule task', {
      isRecurrenceRule: true,
    }),
    createFixture(mockFixtureIds.hiddenTask, 'Fixture hidden task', { readableBy: ['1'] }),
    createFixture(mockFixtureIds.noEditTask, 'Fixture no edit task', {
      editableFieldIdsByUser: { '1': editableFields },
    }),
    createFixture(mockFixtureIds.deadlineControlledParent, 'Fixture controlled parent', {
      deadlineManagedBySubtasks: true,
    }),
    createFixture(mockFixtureIds.conflictTask, 'Fixture conflict task'),
    createFixture(mockFixtureIds.partialTask, 'Fixture partial task'),
  ];
}
