import { describe, expect, it } from 'vitest';

import { createMockCalendar } from '../src/integrations/bitrix/mock/calendar';
import { createMockOrganization } from '../src/integrations/bitrix/mock/organization';
import { createMockScenario } from '../src/integrations/bitrix/mock/scenario';
import { createMockPortalState } from '../src/integrations/bitrix/mock/state';
import { createMockUsers } from '../src/integrations/bitrix/mock/users';

function expectSuccess<T>(result: { ok: true; value: T } | { ok: false }): T {
  if (!result.ok) throw new Error('Expected a successful mock result.');
  return result.value;
}

describe('mock Bitrix users, organization and calendar', () => {
  it('treats an active explicit department head as a manager', async () => {
    const state = createMockPortalState();
    const organization = createMockOrganization(state);

    const departments = expectSuccess(await organization.getLeadership('20'));
    expect(departments.map((department) => department.id)).toEqual(['1', '2']);

    const firstDepartment = state.departments.get('1');
    if (!firstDepartment) throw new Error('Department fixture is unavailable.');
    firstDepartment.headUserId = '11';
    expect(
      expectSuccess(await organization.getLeadership('20')).map((department) => department.id),
    ).toEqual(['2']);
  });

  it('reports a deactivated current user as unauthenticated', async () => {
    const state = createMockPortalState();
    const users = createMockUsers(
      state,
      createMockScenario([
        {
          method: 'users.getCurrent',
          effect: { kind: 'deactivate_user', userId: '10' },
        },
      ]),
    );

    await expect(users.getCurrent()).resolves.toEqual({
      ok: false,
      failure: { kind: 'not_authenticated' },
    });
  });

  it('returns the portal-wide calendar with configurable timezone', async () => {
    const calendar = createMockCalendar(createMockPortalState({ timeZone: 'Europe/Berlin' }));

    await expect(calendar.getPortalCalendar({ fromYear: 2026, toYear: 2026 })).resolves.toEqual({
      ok: true,
      value: {
        timeZone: 'Europe/Berlin',
        workingWeekdays: [1, 2, 3, 4, 5],
        holidays: expect.arrayContaining(['2026-01-01', '2026-05-01']),
        exceptionalWorkingDays: ['2026-12-26'],
      },
    });
  });
});
