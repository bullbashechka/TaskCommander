import { z } from 'zod';

import { createServerSupabaseClient } from '../../../data/client';
import type { RuntimeEnvironment } from '../../../runtime/configuration';
import type { MockTask } from './fixtures';

const mockTaskSchema = z
  .object({
    id: z.string().regex(/^[0-9]{1,32}$/),
    title: z.string(),
    parentId: z.string().nullable(),
    status: z.enum(['pending', 'in_progress', 'pending_review', 'deferred', 'completed']),
    isTemplate: z.boolean(),
    isRecurrenceRule: z.boolean(),
    isRecurringInstance: z.boolean(),
    deleted: z.boolean(),
    readableBy: z.array(z.string()),
    editableFieldIdsByUser: z.record(z.string(), z.array(z.string())),
    deadlineManagedBySubtasks: z.boolean(),
    values: z.record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]),
    ),
  })
  .strict();

const storedTaskSchema = z
  .object({ task: mockTaskSchema, mutationVersion: z.number().int().positive() })
  .strict();

const applyResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('stale') }),
  z.object({ kind: z.literal('conflict') }),
  z.object({ kind: z.literal('invalid') }),
  z.object({ kind: z.literal('no_change') }),
  z.object({
    kind: z.literal('success'),
    appliedFieldIds: z.array(z.string()),
    afterMutationVersion: z.number().int().positive(),
  }),
]);

export interface MockTaskPersistence {
  read(taskId: string): Promise<{ task: MockTask; mutationVersion: number } | null>;
  list(): Promise<readonly { task: MockTask; mutationVersion: number }[]>;
  mutate(task: MockTask, expectedMutationVersion: number): Promise<number | null>;
  apply(input: {
    taskId: string;
    baseTask: MockTask;
    targetValues: Record<string, string | number | boolean | null | string[]>;
    executionFence: {
      operationId: string;
      launchAttempt: number;
      claimId: string;
      expectedMutationVersion: number;
    };
  }): Promise<z.infer<typeof applyResponseSchema>>;
}

export function createSupabaseMockTaskPersistence(
  env: RuntimeEnvironment,
  portalId: string,
): MockTaskPersistence {
  if (env.APP_ENV !== 'local' || env.BITRIX_ADAPTER !== 'mock') {
    throw new Error('Durable mock task storage is local-only.');
  }
  const client = createServerSupabaseClient(env);
  const rpc = client.rpc.bind(client) as unknown as (
    name: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await rpc(name, args);
    if (error) throw new Error(`Mock task storage ${name} failed.`);
    return data;
  }
  return {
    async read(taskId) {
      const value = await call('read_mock_task_state', {
        p_portal_id: portalId,
        p_task_id: taskId,
      });
      return value === null ? null : storedTaskSchema.parse(value);
    },
    async list() {
      return z
        .array(storedTaskSchema)
        .parse(await call('list_mock_task_state', { p_portal_id: portalId }));
    },
    async mutate(task, expectedMutationVersion) {
      const value = await call('mutate_mock_task_state', {
        p_portal_id: portalId,
        p_task_id: task.id,
        p_expected_mutation_version: expectedMutationVersion,
        p_task: task,
      });
      return value === null ? null : z.number().int().positive().parse(value);
    },
    async apply(input) {
      return applyResponseSchema.parse(
        await call('apply_claimed_mock_task_change', {
          p_portal_id: portalId,
          p_operation_id: input.executionFence.operationId,
          p_launch_attempt: input.executionFence.launchAttempt,
          p_task_id: input.taskId,
          p_claim_id: input.executionFence.claimId,
          p_expected_mutation_version: input.executionFence.expectedMutationVersion,
          p_base_task: input.baseTask,
          p_target_values: input.targetValues,
        }),
      );
    },
  };
}
