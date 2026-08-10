import type { BitrixFailure, BitrixNotifications } from '../contract';
import type { MockScenarioController, MockScenarioEffect } from './scenario';
import type { MockPortalState } from './state';

function getFailure(effects: readonly MockScenarioEffect[]): BitrixFailure | null {
  const effect = effects.find((candidate) => candidate.kind === 'return_failure');
  return effect?.kind === 'return_failure' ? effect.failure : null;
}

export function createMockNotifications(
  state: MockPortalState,
  scenario: MockScenarioController = { take: () => [] },
): BitrixNotifications {
  return {
    async sendOnce(request) {
      const effects = scenario.take('notifications.sendOnce', request.recipientId);
      const failure = getFailure(effects);
      if (failure) return { ok: false, failure };

      const existing = state.notifications.find(
        (notification) =>
          notification.recipientId === request.recipientId &&
          notification.deduplicationKey === request.deduplicationKey,
      );
      if (existing) return { ok: true, value: { ...existing } };

      const notification = {
        id: crypto.randomUUID(),
        recipientId: request.recipientId,
        deduplicationKey: request.deduplicationKey,
        message: request.message,
        operationUrl: request.operationUrl,
      };
      state.notifications.push(notification);
      return { ok: true, value: { ...notification } };
    },
  };
}
