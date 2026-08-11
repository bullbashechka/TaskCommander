import { createMockTaskFixtures, type MockTask } from './fixtures';
import { createGeneratedTask, getGeneratedTaskId, isGeneratedTaskId } from './task-generator';

export interface MockUserRecord {
  id: string;
  displayName: string;
  isActive: boolean;
  isAdmin: boolean;
  departmentIds: string[];
}

export interface MockDepartmentRecord {
  id: string;
  name: string;
  parentId: string | null;
  headUserId: string | null;
}

export interface MockCalendarRecord {
  timeZone: string;
  workingWeekdays: number[];
  holidays: string[];
  exceptionalWorkingDays: string[];
}

export interface MockNotificationRecord {
  id: string;
  recipientId: string;
  deduplicationKey: string;
  message: string;
  operationUrl: string;
}

export interface MockDiskRecord {
  id: string;
  operationId: string;
  format: 'xlsx' | 'csv';
  name: string;
  url: string;
  folder: 'active' | 'archive';
  contentHash: string;
  access: { principal: 'user' | 'department'; id: string; level: 'read' }[];
  content: Uint8Array;
  deleted: boolean;
}

export interface MockPortalOptions {
  taskCount?: number;
  currentUserId?: string;
  now?: string;
  timeZone?: string;
}

function cloneTask(task: MockTask): MockTask {
  return {
    ...task,
    readableBy: [...task.readableBy],
    editableFieldIdsByUser: Object.fromEntries(
      Object.entries(task.editableFieldIdsByUser).map(([userId, fields]) => [userId, [...fields]]),
    ),
    values: Object.fromEntries(
      Object.entries(task.values).map(([fieldId, value]) => [
        fieldId,
        Array.isArray(value) ? [...value] : value,
      ]),
    ),
  };
}

export interface MockPortalState {
  taskCount: number;
  currentUserId: string;
  now: string;
  timeZone: string;
  taskOverrides: Map<string, MockTask>;
  users: Map<string, MockUserRecord>;
  departments: Map<string, MockDepartmentRecord>;
  calendar: MockCalendarRecord;
  notifications: MockNotificationRecord[];
  diskRecords: Map<string, MockDiskRecord>;
  diskRecordIdsByOperationFormat: Map<string, string>;
  nextDiskRecordId: number;
  diskFolders: Set<'active' | 'archive'>;
  readonly fixtures: ReadonlyMap<string, MockTask>;
  getTask(taskId: string): MockTask | null;
  getMutableTask(taskId: string): MockTask | null;
  getCandidateTaskIds(): Iterable<string>;
}

export function createMockPortalState(options: MockPortalOptions = {}): MockPortalState {
  const taskCount = options.taskCount ?? 100_000;
  const fixtures = new Map(createMockTaskFixtures().map((task) => [task.id, task]));
  const taskOverrides = new Map<string, MockTask>();
  const users = new Map<string, MockUserRecord>([
    [
      '1',
      {
        id: '1',
        displayName: 'Portal administrator',
        isActive: true,
        isAdmin: true,
        departmentIds: ['1'],
      },
    ],
    [
      '10',
      { id: '10', displayName: 'Operator', isActive: true, isAdmin: false, departmentIds: ['1'] },
    ],
    [
      '11',
      {
        id: '11',
        displayName: 'Finance manager',
        isActive: true,
        isAdmin: false,
        departmentIds: ['3'],
      },
    ],
    [
      '12',
      { id: '12', displayName: 'Observer', isActive: true, isAdmin: false, departmentIds: ['2'] },
    ],
    [
      '13',
      {
        id: '13',
        displayName: 'Project member',
        isActive: true,
        isAdmin: false,
        departmentIds: ['2'],
      },
    ],
    [
      '14',
      {
        id: '14',
        displayName: 'Project member two',
        isActive: true,
        isAdmin: false,
        departmentIds: ['2'],
      },
    ],
    [
      '20',
      {
        id: '20',
        displayName: 'Department manager',
        isActive: true,
        isAdmin: false,
        departmentIds: ['1', '2'],
      },
    ],
    [
      '99',
      {
        id: '99',
        displayName: 'Inactive employee',
        isActive: false,
        isAdmin: false,
        departmentIds: ['3'],
      },
    ],
  ]);
  const departments = new Map<string, MockDepartmentRecord>([
    ['1', { id: '1', name: 'Product', parentId: null, headUserId: '20' }],
    ['2', { id: '2', name: 'Operations', parentId: '1', headUserId: '20' }],
    ['3', { id: '3', name: 'Finance', parentId: null, headUserId: '11' }],
  ]);

  function getBaseTask(taskId: string): MockTask | null {
    const fixture = fixtures.get(taskId);
    if (fixture) {
      return fixture;
    }

    if (!isGeneratedTaskId(taskId, taskCount)) {
      return null;
    }

    return createGeneratedTask(Number(taskId) - 1_000);
  }

  return {
    taskCount,
    currentUserId: options.currentUserId ?? '10',
    now: options.now ?? '2026-08-10T09:00:00+05:00',
    timeZone: options.timeZone ?? 'Asia/Qyzylorda',
    taskOverrides,
    users,
    departments,
    calendar: {
      timeZone: options.timeZone ?? 'Asia/Qyzylorda',
      workingWeekdays: [1, 2, 3, 4, 5],
      holidays: ['2026-01-01', '2026-05-01', '2026-05-09', '2026-12-16'],
      exceptionalWorkingDays: ['2026-12-26'],
    },
    notifications: [],
    diskRecords: new Map(),
    diskRecordIdsByOperationFormat: new Map(),
    nextDiskRecordId: 100,
    diskFolders: new Set(['active']),
    fixtures,
    getTask(taskId) {
      const task = taskOverrides.get(taskId) ?? getBaseTask(taskId);
      return task ? cloneTask(task) : null;
    },
    getMutableTask(taskId) {
      const existing = taskOverrides.get(taskId);
      if (existing) {
        return existing;
      }

      const base = getBaseTask(taskId);
      if (!base) {
        return null;
      }

      const mutable = cloneTask(base);
      taskOverrides.set(taskId, mutable);
      return mutable;
    },
    *getCandidateTaskIds() {
      for (const fixtureId of fixtures.keys()) {
        yield fixtureId;
      }

      for (let index = 0; index < taskCount; index += 1) {
        yield getGeneratedTaskId(index);
      }
    },
  };
}
