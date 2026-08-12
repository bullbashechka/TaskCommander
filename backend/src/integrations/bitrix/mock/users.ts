import type { BitrixFailure, BitrixUsers } from '../contract';
import type { MockScenarioController, MockScenarioEffect } from './scenario';
import type { MockPortalState, MockUserRecord } from './state';

function applyUserEffects(state: MockPortalState, effects: readonly MockScenarioEffect[]): void {
  for (const effect of effects) {
    if (effect.kind !== 'deactivate_user') continue;
    const user = state.users.get(effect.userId);
    if (user) user.isActive = false;
  }
}

function getFailure(effects: readonly MockScenarioEffect[]): BitrixFailure | null {
  const effect = effects.find((candidate) => candidate.kind === 'return_failure');
  return effect?.kind === 'return_failure' ? effect.failure : null;
}

function toBitrixUser(user: {
  id: string;
  displayName: string;
  isActive: boolean;
  isAdmin: boolean;
  departmentIds: string[];
}) {
  return { ...user, departmentIds: [...user.departmentIds] };
}

export function createMockUsers(
  state: MockPortalState,
  scenario: MockScenarioController = { take: () => [] },
): BitrixUsers {
  return {
    async getCurrent() {
      const effects = scenario.take('users.getCurrent', state.currentUserId);
      applyUserEffects(state, effects);
      const failure = getFailure(effects);
      if (failure) return { ok: false, failure };

      const user = state.users.get(state.currentUserId);
      if (!user) return { ok: false, failure: { kind: 'not_authenticated' } };
      return { ok: true, value: toBitrixUser(user) };
    },
    async getByIds(userIds) {
      const effects = scenario.take('users.getByIds');
      applyUserEffects(state, effects);
      const failure = getFailure(effects);
      if (failure) return { ok: false, failure };

      return {
        ok: true,
        value: userIds
          .map((userId) => state.users.get(userId))
          .filter((user): user is MockUserRecord => user !== undefined)
          .map(toBitrixUser),
      };
    },
  };
}
