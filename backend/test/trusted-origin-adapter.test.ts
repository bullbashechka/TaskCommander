import { describe, expect, it, vi } from 'vitest';

import { enforceBitrixOriginPolicy } from '../src/integrations/bitrix/trusted-origin-adapter';

const environment = {
  APP_ENV: 'production',
  APP_ORIGIN: 'https://app.example.test',
  BITRIX_PORTAL_ORIGIN: 'https://portal.bitrix24.ru',
  BITRIX_MEDIA_ALLOWED_ORIGINS: 'https://media.bitrix24.ru',
} as const;

describe('Bitrix configured-origin boundary', () => {
  it('rejects foreign task and employee URLs returned by an adapter', async () => {
    const adapter = enforceBitrixOriginPolicy(
      {
        tasks: {
          search: async () => ({
            ok: true,
            value: {
              items: [{ taskUrl: 'https://attacker.example/task/42' }],
              total: 1,
              hasNextPage: false,
            },
          }),
        },
        users: {
          getEmployeeProfile: async () => ({
            ok: true,
            value: {
              photoUrl: 'https://attacker.example/tracker.png',
              profileUrl: 'https://portal.bitrix24.ru/company/personal/user/42/',
            },
          }),
        },
      } as never,
      environment,
    );

    await expect(adapter.tasks.search({} as never)).resolves.toEqual({
      ok: false,
      failure: { kind: 'invalid_external_response' },
    });
    await expect(adapter.users.getEmployeeProfile('42')).resolves.toEqual({
      ok: false,
      failure: { kind: 'invalid_external_response' },
    });
  });

  it('rejects foreign disk URLs and application links before side effects', async () => {
    const sendOnce = vi.fn();
    const adapter = enforceBitrixOriginPolicy(
      {
        notifications: { sendOnce },
        disk: {
          putReportOnce: async () => ({
            ok: true,
            value: { url: 'https://attacker.example/report/42' },
          }),
        },
      } as never,
      environment,
    );

    await expect(adapter.disk.putReportOnce({} as never)).resolves.toEqual({
      ok: false,
      failure: { kind: 'invalid_external_response' },
    });
    await expect(
      adapter.notifications.sendOnce({
        operationUrl: 'https://attacker.example/operations/42',
      } as never),
    ).resolves.toEqual({
      ok: false,
      failure: { kind: 'invalid_external_response' },
    });
    expect(sendOnce).not.toHaveBeenCalled();
  });

  it('accepts an exact loopback HTTP application link only in local mode', async () => {
    const sendOnce = vi.fn(async (request) => ({ ok: true as const, value: request }));
    const adapter = enforceBitrixOriginPolicy({ notifications: { sendOnce } } as never, {
      ...environment,
      APP_ENV: 'local',
      APP_ORIGIN: 'http://localhost:5173',
    });

    await expect(
      adapter.notifications.sendOnce({
        operationUrl: 'http://localhost:5173/operations/42',
      } as never),
    ).resolves.toMatchObject({ ok: true });
    expect(sendOnce).toHaveBeenCalledOnce();
  });
});
