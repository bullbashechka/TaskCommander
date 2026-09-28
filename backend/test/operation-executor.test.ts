import type { BulkOperationDraft, PreflightPreview } from '@task-commander/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { OperationQueueMessage } from '../src/contracts/operation-queue';
import { createMockBitrixAdapter } from '../src/integrations/bitrix/mock';
import type { MockTask } from '../src/integrations/bitrix/mock/fixtures';
import type { MockTaskPersistence } from '../src/integrations/bitrix/mock/persistence';
import { createMockScenario } from '../src/integrations/bitrix/mock/scenario';
import type { RuntimeEnvironment } from '../src/runtime/configuration';
import { encryptExecutionPlan } from '../src/task-changes/execution-plan';
import { executeOperationMessage } from '../src/task-changes/operation-executor';
import type { OperationConsumerRepository } from '../src/task-changes/operation-consumer-repository';
import type { TaskCommanderRepositories } from '../src/data';

async function createHarness(count: number, failFirstSend = false, lostResponse = false) {
  const keyBase64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(23)));
  const draftId = '10000000-0000-4000-8000-000000000022';
  const token = '123e4567-e89b-42d3-a456-426614174021';
  const operationId = '123e4567-e89b-42d3-a456-426614174022';
  const selectedTaskIds = Array.from({ length: count }, (_, index) => String(1000 + index));
  const saved = new Map<string, { task: MockTask; mutationVersion: number }>();
  const claims = new Map<
    string,
    {
      claim_id: string;
      phase: 'prepared' | 'writing' | 'applied' | 'done';
      before_version: string | null;
      before_mutation_version: number | null;
      after_mutation_version: number | null;
      applied_field_ids: string[];
      lease_until: string;
    }
  >();
  const persistence: MockTaskPersistence = {
    async read(taskId) {
      return saved.get(taskId) ?? null;
    },
    async list() {
      return [...saved.values()];
    },
    async mutate(task, expectedMutationVersion) {
      const currentVersion = saved.get(task.id)?.mutationVersion ?? 0;
      if (currentVersion !== expectedMutationVersion) return null;
      saved.set(task.id, { task, mutationVersion: currentVersion + 1 });
      return currentVersion + 1;
    },
    async apply({ taskId, baseTask, targetValues, executionFence }) {
      const claim = claims.get(taskId);
      if (!claim || claim.claim_id !== executionFence.claimId || claim.phase !== 'writing')
        return { kind: 'stale' };
      const currentVersion = saved.get(taskId)?.mutationVersion ?? 0;
      if (currentVersion !== executionFence.expectedMutationVersion) return { kind: 'conflict' };
      const current = saved.get(taskId)?.task ?? baseTask;
      const nextVersion = currentVersion + 1;
      saved.set(taskId, {
        task: {
          ...current,
          title: typeof targetValues.title === 'string' ? targetValues.title : current.title,
          values: { ...current.values, ...targetValues },
        },
        mutationVersion: nextVersion,
      });
      claim.phase = 'applied';
      claim.after_mutation_version = nextVersion;
      claim.applied_field_ids = Object.keys(targetValues);
      return {
        kind: 'success',
        appliedFieldIds: Object.keys(targetValues),
        afterMutationVersion: nextVersion,
      };
    },
  };
  const adapter = createMockBitrixAdapter({
    currentUserId: '1',
    taskCount: count,
    taskPersistence: persistence,
    scenario: createMockScenario(
      lostResponse
        ? [
            {
              method: 'tasks.applyChange',
              entityId: '1000',
              effect: { kind: 'apply_then_drop_response', appliedFieldIds: ['title'] },
            },
          ]
        : [],
    ),
  });
  const snapshots = await Promise.all(
    selectedTaskIds.map(async (taskId) => {
      const snapshot = await adapter.tasks.readForChange({ taskId, fieldIds: ['title'] });
      if (!snapshot.ok) throw new Error('Missing mock task.');
      return snapshot.value;
    }),
  );
  const draft = {
    id: draftId,
    ownerId: '1',
    revision: 2,
    status: 'awaiting_confirmation',
    filters: [],
    sort: { fieldId: 'deadline', direction: 'asc' },
    selectedTaskIds,
    changes: [{ fieldId: 'title', kind: 'text', action: 'set', value: 'After' }],
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    expiresAt: '2026-09-29T00:00:00.000Z',
  } as BulkOperationDraft;
  const preview = {
    draftId,
    sourceDraftRevision: 1,
    draftRevision: 2,
    actorAccessVersion: null,
    checkedAt: '2026-09-28T00:00:00.000Z',
    canProceed: true,
    entries: selectedTaskIds.map((taskId, index) => ({
      taskId,
      title: 'Task',
      taskUrl: `https://portal.bitrix24.ru/tasks/${taskId}`,
      disposition: 'eligible',
      changedFieldIds: ['title'],
      reasonCode: null,
      reasonMessage: null,
      relevantVersion: snapshots[index]?.relevantVersion ?? '',
      currentValues: { title: snapshots[index]?.values.title ?? null },
      targetValues: { title: 'After' },
    })),
    summary: {
      selected: count,
      eligible: count,
      excluded: 0,
      unchanged: 0,
      successful: 0,
      failed: 0,
      unconfirmed: 0,
      conflicted: 0,
      partiallyApplied: 0,
      notProcessed: 0,
    },
  } as PreflightPreview;
  const encrypted = await encryptExecutionPlan({
    keyBase64,
    portalId: 'portal-1',
    ownerId: '1',
    token,
    draft,
    preview,
  });
  const message: OperationQueueMessage = {
    schemaVersion: 1,
    kind: 'operation.execute',
    portalId: 'portal-1',
    operationId,
    launchAttempt: 1,
    messageId: '123e4567-e89b-42d3-a456-426614174023',
    createdAt: '2026-09-28T00:00:00.000Z',
  };
  const recorded = new Set<string>();
  const outcomes: string[] = [];
  const protectedPayloads: string[] = [];
  const send = vi.fn().mockImplementation(async () => {
    if (failFirstSend && send.mock.calls.length === 1) throw new Error('send failed');
  });
  const stored = {
    operation: {
      id: operationId,
      portal_id: 'portal-1',
      initiator_id: '1',
      status: 'running',
      launch_attempt: 1,
      idempotency_key: `confirmation:${token}`,
      preflight_snapshot: { draftId, draftRevision: 2 },
      cancel_requested_at: null,
      interruption_requested_at: null,
    },
    plan: { ...encrypted, payloadVersion: 1 },
    access: null,
  };
  const finalizeOperation = vi.fn().mockImplementation(async () => {
    stored.operation.status = 'completed';
    return { operation: { status: 'completed' } };
  });
  const consumerRepository = {
    readExecution: vi
      .fn()
      .mockImplementation(async () => (stored.operation.status === 'completed' ? null : stored)),
    reserveRateSlot: vi.fn().mockResolvedValue(0),
    claim: vi
      .fn()
      .mockImplementation(
        async (_portalId: string, _operationId: string, _launchAttempt: number, taskId: string) => {
          if (recorded.has(taskId)) return { disposition: 'done' };
          const claim = {
            claim_id: crypto.randomUUID(),
            phase: 'prepared' as const,
            before_version: null,
            before_mutation_version: null,
            after_mutation_version: null,
            applied_field_ids: [],
            lease_until: '2026-09-28T00:02:00.000Z',
          };
          claims.set(taskId, claim);
          return { disposition: 'claimed', claim };
        },
      ),
    markWriting: vi
      .fn()
      .mockImplementation(
        async ({
          taskId,
          protectedResult,
        }: {
          taskId: string;
          protectedResult: { ciphertext: string };
        }) => {
          const claim = claims.get(taskId);
          if (!claim) return false;
          claim.phase = 'writing';
          protectedPayloads.push(protectedResult.ciphertext);
          return true;
        },
      ),
    readClaim: vi
      .fn()
      .mockImplementation(
        async (_portalId: string, _operationId: string, taskId: string) =>
          claims.get(taskId) ?? null,
      ),
    record: vi.fn().mockImplementation(async (input: { taskId: string; outcome: string }) => {
      recorded.add(input.taskId);
      outcomes.push(input.outcome);
      const claim = claims.get(input.taskId);
      if (claim) claim.phase = 'done';
      return { inserted: true };
    }),
  } as unknown as OperationConsumerRepository;
  const operations = {
    startOperation: vi.fn().mockResolvedValue({ operation: { status: 'running' } }),
    requestOperationInterruption: vi.fn(),
    finalizeOperation,
  } as unknown as TaskCommanderRepositories;
  const env = {
    OPERATION_PLAN_KEY_V1: keyBase64,
    OPERATIONS_QUEUE: { send },
  } as unknown as RuntimeEnvironment;
  return {
    message,
    consumerRepository,
    operations,
    env,
    adapter,
    recorded,
    saved,
    outcomes,
    protectedPayloads,
    send,
    finalizeOperation,
  };
}

describe('operation consumer continuation', () => {
  it('finalizes exactly 100 eligible tasks without another Queue message', async () => {
    const harness = await createHarness(100);
    await executeOperationMessage(harness);
    expect(harness.recorded.size).toBe(100);
    expect(harness.outcomes).toHaveLength(100);
    expect(harness.outcomes.every((outcome) => outcome === 'success')).toBe(true);
    expect(harness.protectedPayloads).toHaveLength(100);
    expect(harness.saved.size).toBe(100);
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.finalizeOperation).toHaveBeenCalledOnce();
  });

  it('continues after 100 newly claimed tasks and skips prior results on redelivery', async () => {
    const harness = await createHarness(101);
    await executeOperationMessage(harness);
    expect(harness.recorded.size).toBe(100);
    expect(harness.send).toHaveBeenCalledOnce();
    expect(harness.finalizeOperation).not.toHaveBeenCalled();
    await executeOperationMessage(harness);
    expect(harness.recorded.size).toBe(101);
    expect(harness.outcomes.every((outcome) => outcome === 'success')).toBe(true);
    expect(harness.send).toHaveBeenCalledOnce();
    expect(harness.finalizeOperation).toHaveBeenCalledOnce();
  });

  it('retains the first 100 results when continuation send fails and redelivery resumes', async () => {
    const harness = await createHarness(101, true);
    await expect(executeOperationMessage(harness)).rejects.toThrow('send failed');
    expect(harness.recorded.size).toBe(100);
    expect(harness.finalizeOperation).not.toHaveBeenCalled();
    await executeOperationMessage(harness);
    expect(harness.recorded.size).toBe(101);
    expect(harness.outcomes.every((outcome) => outcome === 'success')).toBe(true);
    expect(harness.finalizeOperation).toHaveBeenCalledOnce();
  });

  it('reconciles a lost write response and ignores a duplicate Queue delivery', async () => {
    const harness = await createHarness(1, false, true);
    await executeOperationMessage(harness);
    expect(harness.outcomes).toEqual(['success']);
    expect(harness.saved.get('1000')?.mutationVersion).toBe(1);
    await executeOperationMessage(harness);
    expect(harness.outcomes).toEqual(['success']);
    expect(harness.saved.get('1000')?.mutationVersion).toBe(1);
    expect(harness.finalizeOperation).toHaveBeenCalledOnce();
  });

  it('interrupts an undecipherable plan before operation start', async () => {
    const harness = await createHarness(1);
    await executeOperationMessage({
      ...harness,
      env: { ...harness.env, OPERATION_PLAN_KEY_V1: btoa('wrong key') },
    });
    expect(harness.operations.requestOperationInterruption).toHaveBeenCalledOnce();
    expect(harness.operations.startOperation).not.toHaveBeenCalled();
    expect(harness.finalizeOperation).toHaveBeenCalledOnce();
  });

  it('interrupts a revoked actor before operation start', async () => {
    const harness = await createHarness(1);
    const actor = await harness.adapter.users.getCurrent();
    if (!actor.ok) throw new Error('Missing mock actor.');
    vi.spyOn(harness.adapter.users, 'getCurrent').mockResolvedValue({
      ok: true,
      value: { ...actor.value, isActive: false },
    });
    await executeOperationMessage(harness);
    expect(harness.operations.requestOperationInterruption).toHaveBeenCalledOnce();
    expect(harness.operations.startOperation).not.toHaveBeenCalled();
    expect(harness.finalizeOperation).toHaveBeenCalledOnce();
  });

  it('interrupts a permanently unavailable field catalog before start', async () => {
    const harness = await createHarness(1);
    vi.spyOn(harness.adapter.tasks, 'getFieldCapabilities').mockResolvedValueOnce({
      ok: false,
      failure: { kind: 'unsupported_capability', capability: 'task_fields' },
    });
    await executeOperationMessage(harness);
    expect(harness.operations.requestOperationInterruption).toHaveBeenCalledOnce();
    expect(harness.operations.startOperation).not.toHaveBeenCalled();
    expect(harness.finalizeOperation).toHaveBeenCalledOnce();
  });

  it('finalizes an attempt when actor access is revoked after start', async () => {
    const harness = await createHarness(1);
    const actor = await harness.adapter.users.getCurrent();
    if (!actor.ok) throw new Error('Missing mock actor.');
    vi.spyOn(harness.adapter.users, 'getCurrent')
      .mockResolvedValueOnce(actor)
      .mockResolvedValueOnce({ ok: true, value: { ...actor.value, isActive: false } });
    await executeOperationMessage(harness);
    expect(harness.operations.startOperation).toHaveBeenCalledOnce();
    expect(harness.operations.requestOperationInterruption).toHaveBeenCalledOnce();
    expect(harness.finalizeOperation).toHaveBeenCalledOnce();
    expect(harness.saved.size).toBe(0);
  });

  it('waits through a long portal rate slot before committing write intent', async () => {
    const harness = await createHarness(1);
    let slots = 0;
    vi.spyOn(harness.consumerRepository, 'reserveRateSlot').mockImplementation(async () =>
      ++slots === 3 ? 120_001 : 0,
    );
    vi.useFakeTimers();
    try {
      const execution = executeOperationMessage(harness);
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.consumerRepository.markWriting).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(120_001);
      await execution;
      expect(harness.consumerRepository.markWriting).toHaveBeenCalledOnce();
      expect(harness.outcomes).toEqual(['success']);
    } finally {
      vi.useRealTimers();
    }
  });
});
