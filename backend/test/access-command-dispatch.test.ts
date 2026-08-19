import { describe, expect, it, vi } from 'vitest';

import { dispatchPendingAccessCommands } from '../src/access-management/dispatch';

describe('access command dispatch recovery', () => {
  it('re-enqueues a stale accepted command after Queue retries are exhausted', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const repository = {
      listPendingCommandDispatches: vi.fn().mockResolvedValue([]),
      listStaleCommands: vi.fn().mockResolvedValue([
        {
          id: '123e4567-e89b-42d3-a456-426614174000',
          portal_id: 'portal-1',
          state: 'accepted',
          accepted_at: '2026-08-18T00:00:00.000Z',
          started_at: null,
        },
      ]),
    };

    await dispatchPendingAccessCommands({ ACCESS_COMMANDS_QUEUE: { send } }, repository as never);

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'access.command.execute',
        portalId: 'portal-1',
        commandId: '123e4567-e89b-42d3-a456-426614174000',
      }),
    );
  });
});
