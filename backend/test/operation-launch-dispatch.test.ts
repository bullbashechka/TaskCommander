import { describe, expect, it, vi } from 'vitest';

import type { TaskCommanderRepositories } from '../src/data';
import type { OperationConsumerRepository } from '../src/task-changes/operation-consumer-repository';
import {
  dispatchOperationLaunch,
  dispatchPendingOperationLaunches,
  redriveStalledOperations,
} from '../src/task-changes/dispatch';

const dispatch = {
  operation_id: '123e4567-e89b-42d3-a456-426614174000',
  portal_id: 'portal-1',
  launch_attempt: 1,
  message_id: '223e4567-e89b-42d3-a456-426614174000',
  status: 'sending',
  created_at: '2026-09-28T00:00:00.000Z',
  dispatched_at: null,
  claim_id: '323e4567-e89b-42d3-a456-426614174000',
};

function fixture() {
  const send = vi.fn().mockResolvedValue(undefined);
  const claimOperationLaunchDispatch = vi.fn().mockResolvedValue(dispatch);
  const completeOperationLaunchDispatch = vi.fn().mockResolvedValue(undefined);
  return {
    env: { OPERATIONS_QUEUE: { send } as unknown as Queue },
    repository: {
      claimOperationLaunchDispatch,
      completeOperationLaunchDispatch,
    } as unknown as TaskCommanderRepositories,
    send,
    claimOperationLaunchDispatch,
    completeOperationLaunchDispatch,
  };
}

const input = {
  portalId: 'portal-1',
  operationId: dispatch.operation_id,
  correlationId: 'TC-00000000-0000-4000-8000-000000000021',
};

describe('operation launch dispatch', () => {
  it('sends the stable envelope and marks the same claim dispatched', async () => {
    const item = fixture();
    await dispatchOperationLaunch({ ...input, env: item.env, repository: item.repository });
    expect(item.send).toHaveBeenCalledWith(
      expect.objectContaining({
        portalId: dispatch.portal_id,
        operationId: dispatch.operation_id,
        launchAttempt: 1,
        messageId: dispatch.message_id,
      }),
    );
    expect(item.completeOperationLaunchDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        sent: true,
        claimId: dispatch.claim_id,
      }),
    );
  });

  it('records a failed send but does not fail an operation after a successful send', async () => {
    const failed = fixture();
    failed.send.mockRejectedValueOnce(new Error('send failed'));
    await expect(
      dispatchOperationLaunch({ ...input, env: failed.env, repository: failed.repository }),
    ).rejects.toThrow('send failed');
    expect(failed.completeOperationLaunchDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ sent: false }),
    );

    const ambiguous = fixture();
    ambiguous.completeOperationLaunchDispatch.mockRejectedValueOnce(new Error('receipt lost'));
    await expect(
      dispatchOperationLaunch({ ...input, env: ambiguous.env, repository: ambiguous.repository }),
    ).rejects.toThrow('receipt lost');
    expect(ambiguous.completeOperationLaunchDispatch).toHaveBeenCalledTimes(1);
    expect(ambiguous.completeOperationLaunchDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ sent: true }),
    );
  });

  it('does not send when another publisher owns the claim', async () => {
    const item = fixture();
    item.claimOperationLaunchDispatch.mockResolvedValueOnce(null);
    await dispatchOperationLaunch({ ...input, env: item.env, repository: item.repository });
    expect(item.send).not.toHaveBeenCalled();
  });

  it('uses an audit-safe correlation ID during cron recovery', async () => {
    const item = fixture();
    const repository = {
      ...item.repository,
      listRecoverableOperationDispatches: vi.fn().mockResolvedValue([dispatch]),
    } as unknown as TaskCommanderRepositories;
    await dispatchPendingOperationLaunches(item.env, repository);
    expect(item.completeOperationLaunchDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: expect.stringMatching(
          /^TC-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        ),
      }),
    );
  });

  it('redrives a stalled running attempt with its stable envelope after a send failure', async () => {
    const item = fixture();
    const repository = {
      claimStalledExecutions: vi.fn().mockResolvedValue([dispatch]),
    } as unknown as OperationConsumerRepository;
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      item.send.mockRejectedValueOnce(new Error('temporary queue failure'));
      await redriveStalledOperations(item.env, repository);
      await redriveStalledOperations(item.env, repository);
      expect(item.send).toHaveBeenCalledTimes(2);
      expect(item.send.mock.calls[0]?.[0]).toEqual(item.send.mock.calls[1]?.[0]);
    } finally {
      log.mockRestore();
    }
  });
});
