import type { BitrixFailure } from '../contract';
import type { MockTaskStatus } from './fixtures';

export type MockScenarioMethod =
  | 'tasks.search'
  | 'tasks.readForChange'
  | 'tasks.applyChange'
  | 'users.getCurrent'
  | 'users.getByIds'
  | 'users.searchEmployees'
  | 'users.getEmployeeProfile'
  | 'organization.getDepartments'
  | 'organization.getLeadership'
  | 'organization.snapshotDepartmentMembers'
  | 'calendar.getPortalCalendar'
  | 'notifications.sendOnce'
  | 'disk.putReportOnce'
  | 'disk.getReport'
  | 'disk.archiveReport'
  | 'disk.deleteReport';

export type MockScenarioEffect =
  | { kind: 'return_failure'; failure: BitrixFailure }
  | {
      kind: 'mutate_task';
      taskId: string;
      patch: {
        status?: MockTaskStatus;
        values?: Record<string, string | number | boolean | null | string[]>;
      };
    }
  | { kind: 'deactivate_user'; userId: string }
  | { kind: 'change_department_head'; departmentId: string; headUserId: string | null }
  | { kind: 'apply_then_drop_response'; appliedFieldIds: readonly string[] }
  | { kind: 'save_file_then_drop_response' };

export interface MockScenarioRule {
  method: MockScenarioMethod;
  occurrence?: number;
  entityId?: string;
  repeat?: 'once' | 'always';
  effect: MockScenarioEffect;
}

export interface MockScenarioController {
  take(method: MockScenarioMethod, entityId?: string): readonly MockScenarioEffect[];
}

export function createMockScenario(
  rules: readonly MockScenarioRule[] = [],
): MockScenarioController {
  const calls = new Map<MockScenarioMethod, number>();
  const consumedRules = new Set<number>();

  return {
    take(method, entityId) {
      const occurrence = (calls.get(method) ?? 0) + 1;
      calls.set(method, occurrence);

      return rules.flatMap((rule, index) => {
        if (
          rule.method !== method ||
          (rule.entityId !== undefined && rule.entityId !== entityId) ||
          (rule.occurrence !== undefined && rule.occurrence !== occurrence) ||
          (rule.repeat !== 'always' && consumedRules.has(index))
        ) {
          return [];
        }

        if (rule.repeat !== 'always') {
          consumedRules.add(index);
        }

        return [rule.effect];
      });
    },
  };
}
