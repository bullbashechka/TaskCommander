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
  const secondViewAllContext = createDataAccessContext({
    portalId,
    actorId: secondUserId,
    permissions: ['view_all_reports'],
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
    const { error } = await client.rpc('purge_integration_test_fixture', {
      p_portal_id: portalId,
    });
    expect(error).toBeNull();
  });

  it('isolates operation history and atomically records concurrent task results', async () => {
    const created = await repositories.createOperation(firstContext, {
      type: 'bulk_change',
      initiatorDisplayName: 'First integration operator',
      sourceOperationId: null,
      idempotencyKey: crypto.randomUUID(),
      filterSnapshot: null,
      selectedTaskIds: ['9001', '9002'],
      changes: [{ schemaVersion: 1 }],
      preflightSnapshot: {},
      summary: { selected: 2, eligible: 2, excluded: 0, unchanged: 0 },
      correlationId: 'TC-123e4567-e89b-42d3-a456-426614174010',
    });
    expect(created.disposition).toBe('created');
    const operation = created.operation;
    await expect(
      repositories.startOperation(firstContext, {
        operationId: operation.id,
        launchAttempt: operation.launchAttempt,
        correlationId: 'TC-123e4567-e89b-42d3-a456-426614174012',
      }),
    ).resolves.toMatchObject({ disposition: 'applied' });

    await expect(
      Promise.all([
        repositories.recordTaskResult(firstContext, {
          operationId: operation.id,
          launchAttempt: operation.launchAttempt,
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
          launchAttempt: operation.launchAttempt,
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

    await expect(repositories.listOperationHistory(secondContext)).resolves.toMatchObject({
      items: [],
    });
    await expect(
      repositories.getOperation(secondViewAllContext, operation.id),
    ).resolves.toMatchObject({ id: operation.id });
    await expect(
      repositories.startOperation(secondViewAllContext, {
        operationId: operation.id,
        launchAttempt: operation.launchAttempt,
        correlationId: 'TC-123e4567-e89b-42d3-a456-426614174011',
      }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE_RECORD' });
    await expect(
      repositories.recordTaskResult(secondViewAllContext, {
        operationId: operation.id,
        launchAttempt: operation.launchAttempt,
        taskId: '9003',
        title: 'Unauthorized result',
        taskUrl: 'https://example.test/task/9003',
        outcome: 'success',
        requestedFieldIds: [],
        appliedFieldIds: [],
        failedFieldIds: [],
        reasonCode: null,
        reasonMessage: null,
        correlationId: null,
        canRetry: false,
      }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE_RECORD' });
    await expect(repositories.listTaskResults(firstContext, operation.id)).resolves.toHaveLength(2);
    await expect(repositories.getOperation(firstContext, operation.id)).resolves.toMatchObject({
      summary: expect.objectContaining({ successful: 1, failed: 1 }),
    });
  });
  });
}
