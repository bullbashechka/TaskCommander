import type { BitrixFailure, BitrixOrganization } from '../contract';
import type { MockScenarioController, MockScenarioEffect } from './scenario';
import type { MockPortalState } from './state';

function applyOrganizationEffects(
  state: MockPortalState,
  effects: readonly MockScenarioEffect[],
): void {
  for (const effect of effects) {
    if (effect.kind !== 'change_department_head') continue;
    const department = state.departments.get(effect.departmentId);
    if (department) department.headUserId = effect.headUserId;
  }
}

function getFailure(effects: readonly MockScenarioEffect[]): BitrixFailure | null {
  const effect = effects.find((candidate) => candidate.kind === 'return_failure');
  return effect?.kind === 'return_failure' ? effect.failure : null;
}

function toDepartment(department: {
  id: string;
  name: string;
  parentId: string | null;
  headUserId: string | null;
}) {
  return { ...department };
}

export function createMockOrganization(
  state: MockPortalState,
  scenario: MockScenarioController = { take: () => [] },
): BitrixOrganization {
  return {
    async getDepartments() {
      const effects = scenario.take('organization.getDepartments');
      applyOrganizationEffects(state, effects);
      const failure = getFailure(effects);
      if (failure) return { ok: false, failure };

      return { ok: true, value: [...state.departments.values()].map(toDepartment) };
    },
    async getLeadership(userId) {
      const effects = scenario.take('organization.getLeadership', userId);
      applyOrganizationEffects(state, effects);
      const failure = getFailure(effects);
      if (failure) return { ok: false, failure };

      const user = state.users.get(userId);
      if (!user || !user.isActive) return { ok: true, value: [] };
      return {
        ok: true,
        value: [...state.departments.values()]
          .filter((department) => department.headUserId === userId)
          .map(toDepartment),
      };
    },
  };
}
