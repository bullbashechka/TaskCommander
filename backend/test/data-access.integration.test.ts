import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';

import { createDataAccessContext } from '../src/data/access';
import { createServerSupabaseClient } from '../src/data/client';
import { TaskCommanderRepositories } from '../src/data/repositories';

const integrationEnabled =
  typeof env.SUPABASE_URL === 'string' &&
  env.SUPABASE_URL.length > 0 &&
  typeof env.SUPABASE_SERVICE_ROLE_KEY === 'string' &&
  env.SUPABASE_SERVICE_ROLE_KEY.length > 0;

if (integrationEnabled) {
  describe('Supabase data access integration', () => {
  const portalId = `integration-${crypto.randomUUID()}`;
  const firstUserId = '900000000001';
  const secondUserId = '900000000002';
  const client = createServerSupabaseClient(env);
  const repositories = new TaskCommanderRepositories(client);
  const operationIds: string[] = [];
  const firstContext = createDataAccessContext({
    portalId,
    actorId: firstUserId,
    permissions: ['view_own_reports'],
  });
  const secondContext = createDataAccessContext({
    portalId,
    actorId: secondUserId,
    permissions: ['view_own_reports'],
  });

  beforeAll(async () => {
    const { error: portalError } = await client
      .from('portal')
      .insert({ id: portalId, display_name: 'Integration portal' });
    expect(portalError).toBeNull();

    const { error: usersError } = await client.from('user_settings').insert([
      {
        portal_id: portalId,
        user_id: firstUserId,
        display_name: 'First integration operator',
        access_active: true,
        permissions: ['view_own_reports'],
      },
      {
        portal_id: portalId,
        user_id: secondUserId,
        display_name: 'Second integration operator',
        access_active: true,
        permissions: ['view_own_reports'],
      },
    ]);
    expect(usersError).toBeNull();
  });

  afterAll(async () => {
    if (operationIds.length > 0) {
      await client.from('task_processing_result').delete().in('operation_id', operationIds);
    }
    await client.from('bulk_operation').delete().eq('portal_id', portalId);
    await client.from('operation_draft').delete().eq('portal_id', portalId);
    await client.from('saved_filter').delete().eq('portal_id', portalId);
    await client.from('user_settings').delete().eq('portal_id', portalId);
    await client.from('portal').delete().eq('id', portalId);
  });

  it('isolates operation history and atomically records concurrent task results', async () => {
    const operation = await repositories.createOperation(firstContext, {
      type: 'bulk_change',
      initiatorDisplayName: 'First integration operator',
      sourceOperationId: null,
      idempotencyKey: crypto.randomUUID(),
      filterSnapshot: null,
      selectedTaskIds: ['9001', '9002'],
      changes: [{ schemaVersion: 1 }],
      preflightSnapshot: {},
      summary: { selected: 2, eligible: 2, excluded: 0, unchanged: 0 },
    });
    operationIds.push(operation.id);

    await expect(
      Promise.all([
        repositories.recordTaskResult(firstContext, {
          operationId: operation.id,
          taskId: '9001',
          title: 'First task',
          taskUrl: 'https://example.test/task/9001',
          outcome: 'success',
          requestedFieldIds: [],
          appliedFieldIds: [],
          failedFieldIds: [],
          reasonCode: null,
          reasonMessage: null,
          correlationId: null,
          canRetry: false,
        }),
        repositories.recordTaskResult(firstContext, {
          operationId: operation.id,
          taskId: '9002',
          title: 'Second task',
          taskUrl: 'https://example.test/task/9002',
          outcome: 'error',
          requestedFieldIds: [],
          appliedFieldIds: [],
          failedFieldIds: [],
          reasonCode: 'UPSTREAM_FAILURE',
          reasonMessage: 'Temporary failure',
          correlationId: null,
          canRetry: true,
        }),
      ]),
    ).resolves.toHaveLength(2);

    await expect(repositories.listOperationHistory(secondContext)).resolves.toMatchObject({ items: [] });
    await expect(repositories.listTaskResults(firstContext, operation.id)).resolves.toHaveLength(2);
    await expect(repositories.getOperation(firstContext, operation.id)).resolves.toMatchObject({
      summary: expect.objectContaining({ successful: 1, failed: 1 }),
    });
  });
  });
}
