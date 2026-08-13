import { employeeSearchRequestSchema } from '../schemas';
import type { BitrixEmployeeProfile, BitrixFailure, BitrixUsers } from '../contract';
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

function toEmployeeProfile(user: MockUserRecord): BitrixEmployeeProfile {
  return {
    ...toBitrixUser(user),
    email: user.email ?? null,
    position: user.position ?? null,
    photoUrl: user.photoUrl ?? null,
    profileUrl: user.profileUrl ?? `https://example.bitrix24.test/company/personal/user/${user.id}/`,
  };
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
    async searchEmployees(input) {
      const effects = scenario.take('users.searchEmployees');
      applyUserEffects(state, effects);
      const failure = getFailure(effects);
      if (failure) return { ok: false, failure };

      const request = employeeSearchRequestSchema.parse(input);
      const offset = request.cursor === null ? 0 : Number(request.cursor);
      if (!Number.isSafeInteger(offset) || offset < 0) {
        return { ok: false, failure: { kind: 'invalid_external_response' } };
      }
      const query = request.query.toLocaleLowerCase('ru');
      const matches = [...state.users.values()]
        .filter((user) => request.includeInactive || user.isActive)
        .filter(
          (user) =>
            request.departmentId === null || user.departmentIds.includes(request.departmentId),
        )
        .filter((user) => {
          if (query === '') return true;
          return [user.displayName, user.position ?? '', user.email ?? ''].some((value) =>
            value.toLocaleLowerCase('ru').includes(query),
          );
        })
        .sort((left, right) => left.displayName.localeCompare(right.displayName, 'ru'));
      const items = matches.slice(offset, offset + request.pageSize).map(toEmployeeProfile);
      const nextOffset = offset + items.length;
      return {
        ok: true,
        value: {
          items,
          total: matches.length,
          nextCursor: nextOffset < matches.length ? String(nextOffset) : null,
        },
      };
    },
    async getEmployeeProfile(userId) {
      const effects = scenario.take('users.getEmployeeProfile', userId);
      applyUserEffects(state, effects);
      const failure = getFailure(effects);
      if (failure) return { ok: false, failure };

      const user = state.users.get(userId);
      return user
        ? { ok: true, value: toEmployeeProfile(user) }
        : { ok: false, failure: { kind: 'not_found_or_forbidden' } };
    },
  };
}
