import type { BitrixAdapter } from '../contract';
import { createMockCalendar } from './calendar';
import { createMockDisk } from './disk';
import { createMockNotifications } from './notifications';
import { createMockOrganization } from './organization';
import { createMockScenario, type MockScenarioController } from './scenario';
import { createMockPortalState, type MockPortalOptions, type MockPortalState } from './state';
import { createMockTasks } from './tasks';
import { createMockUsers } from './users';

export interface MockBitrixAdapter extends BitrixAdapter {
  readonly state: MockPortalState;
  readonly scenario: MockScenarioController;
}

export interface CreateMockBitrixAdapterOptions extends MockPortalOptions {
  scenario?: MockScenarioController;
}

export function createMockBitrixAdapter(
  options: CreateMockBitrixAdapterOptions = {},
): MockBitrixAdapter {
  const state = createMockPortalState(options);
  const scenario = options.scenario ?? createMockScenario();

  return {
    state,
    scenario,
    tasks: createMockTasks(state, scenario),
    users: createMockUsers(state, scenario),
    organization: createMockOrganization(state, scenario),
    calendar: createMockCalendar(state, scenario),
    notifications: createMockNotifications(state, scenario),
    disk: createMockDisk(state, scenario),
  };
}
