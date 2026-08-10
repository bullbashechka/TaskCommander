import type { BitrixCalendar, BitrixFailure } from '../contract';
import type { MockScenarioController, MockScenarioEffect } from './scenario';
import type { MockPortalState } from './state';

function getFailure(effects: readonly MockScenarioEffect[]): BitrixFailure | null {
  const effect = effects.find((candidate) => candidate.kind === 'return_failure');
  return effect?.kind === 'return_failure' ? effect.failure : null;
}

export function createMockCalendar(
  state: MockPortalState,
  scenario: MockScenarioController = { take: () => [] },
): BitrixCalendar {
  return {
    async getPortalCalendar(input) {
      const effects = scenario.take('calendar.getPortalCalendar');
      const failure = getFailure(effects);
      if (failure) return { ok: false, failure };
      if (
        !Number.isInteger(input.fromYear) ||
        !Number.isInteger(input.toYear) ||
        input.fromYear > input.toYear
      ) {
        return {
          ok: false,
          failure: {
            kind: 'permanent_failure',
            reasonCode: 'invalid_calendar_range',
            fieldIds: [],
          },
        };
      }

      return {
        ok: true,
        value: {
          timeZone: state.calendar.timeZone,
          workingWeekdays: [...state.calendar.workingWeekdays],
          holidays: state.calendar.holidays.filter((date) => {
            const year = Number(date.slice(0, 4));
            return year >= input.fromYear && year <= input.toYear;
          }),
          exceptionalWorkingDays: state.calendar.exceptionalWorkingDays.filter((date) => {
            const year = Number(date.slice(0, 4));
            return year >= input.fromYear && year <= input.toYear;
          }),
        },
      };
    },
  };
}
