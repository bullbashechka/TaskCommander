import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';

import {
  createDataAccessContext,
  createSystemConsumerContext,
  resolveEffectiveAccess,
  type DataAccessContext,
  type SystemConsumerContext,
} from '../src/data/access';
import { createServerSupabaseClient } from '../src/data/client';
import { TaskCommanderRepositories } from '../src/data/repositories';
import { createVerifiedTestPrincipal } from './verified-session-test-helper';

const integrationEnabled =
  typeof env.SUPABASE_URL === 'string' &&
  env.SUPABASE_URL.length > 0 &&
  typeof env.SUPABASE_SERVICE_ROLE_KEY === 'string' &&
  env.SUPABASE_SERVICE_ROLE_KEY.length > 0;

if (integrationEnabled) {
  describe('Supabase data access integration', () => {
    // The database is disposable and reset by db:docker:reset. Keeping cleanup outside the
    // deployable API preserves append-only audit guarantees and avoids a production backdoor.
    const portalId = `integration-${crypto.randomUUID()}`;
    const firstUserId = '900000000001';
    const secondUserId = '900000000002';
    const client = createServerSupabaseClient(env);
    const repositories = new TaskCommanderRepositories(client, ['https://portal.bitrix24.ru']);
    let firstContext: DataAccessContext | undefined;
    let firstSystemContext: SystemConsumerContext | undefined;
    let secondContext: DataAccessContext | undefined;
    let secondSystemContext: SystemConsumerContext | undefined;
    let secondViewAllContext: DataAccessContext | undefined;

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
          permissions: [
            'app_access',
            'view_own_reports',
            'change_allowed_fields',
            'run_bulk_operations',
          ],
          allowed_field_ids: ['TITLE'],
        },
        {
          portal_id: portalId,
          user_id: secondUserId,
          display_name: 'Second integration operator',
          access_active: true,
          permissions: [
            'app_access',
            'view_own_reports',
            'change_allowed_fields',
            'run_bulk_operations',
          ],
          allowed_field_ids: ['TITLE'],
        },
      ]);
      expect(usersError).toBeNull();

      firstContext = createDataAccessContext(
        await resolveEffectiveAccess(
          await createVerifiedTestPrincipal({
            portalId,
            userId: firstUserId,
            displayName: 'First integration operator',
            isBitrixAdmin: false,
          }),
          repositories,
        ),
      );
      firstSystemContext = createSystemConsumerContext(portalId, firstUserId);
      secondContext = createDataAccessContext(
        await resolveEffectiveAccess(
          await createVerifiedTestPrincipal({
            portalId,
            userId: secondUserId,
            displayName: 'Second integration operator',
            isBitrixAdmin: false,
          }),
          repositories,
        ),
      );
      secondSystemContext = createSystemConsumerContext(portalId, secondUserId);
      await expect(
        resolveEffectiveAccess(
          await createVerifiedTestPrincipal({
            portalId: `other-${portalId}`,
            userId: secondUserId,
            displayName: 'Second integration operator',
            isBitrixAdmin: false,
          }),
          repositories,
        ),
      ).rejects.toMatchObject({ kind: 'forbidden' });
      secondViewAllContext = createDataAccessContext(
        await resolveEffectiveAccess(
          await createVerifiedTestPrincipal({
            portalId,
            userId: secondUserId,
            displayName: 'Second integration operator',
            isBitrixAdmin: false,
          }),
          {
            findEffectiveAccessSettings: async () => ({
              accessActive: true,
              permissions: ['app_access', 'view_all_reports'],
              allowedFieldIds: [],
              accessVersion: 1,
            }),
          },
        ),
      );
    });

    it('isolates saved filters by portal and owner', async () => {
      if (!firstContext || !secondContext) {
        throw new Error('Integration access contexts were not initialized.');
      }

      const created = await repositories.createSavedFilter(firstContext, {
        name: 'First owner filter',
        filterPayload: [],
      });

      await expect(repositories.listSavedFilters(firstContext)).resolves.toEqual([created]);
      await expect(repositories.listSavedFilters(secondContext)).resolves.toEqual([]);
      await expect(
        repositories.updateSavedFilter(secondContext, {
          id: created.id,
          expectedRevision: created.revision,
          name: 'Hijacked',
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(
        repositories.deleteSavedFilter(secondContext, {
          id: created.id,
          expectedRevision: created.revision,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(
        repositories.deleteSavedFilter(firstContext, {
          id: created.id,
          expectedRevision: created.revision,
        }),
      ).resolves.toBeUndefined();
    });

    it('bootstraps an administrator identity without granting persisted access', async () => {
      const administratorId = '900000000003';
      const administratorContext = createDataAccessContext(
        await resolveEffectiveAccess(
          await createVerifiedTestPrincipal({
            portalId,
            userId: administratorId,
            displayName: 'Integration administrator',
            isBitrixAdmin: true,
          }),
          repositories,
        ),
      );

      await repositories.ensurePrincipalIdentity(administratorContext, 'Integration administrator');
      await expect(
        repositories.createSavedFilter(administratorContext, {
          name: 'Administrator filter',
          filterPayload: [],
        }),
      ).resolves.toMatchObject({ name: 'Administrator filter' });
      const { data, error } = await client
        .from('user_settings')
        .select('access_active, permissions, allowed_field_ids')
        .eq('portal_id', portalId)
        .eq('user_id', administratorId)
        .single();

      expect(error).toBeNull();
      expect(data).toEqual({ access_active: false, permissions: [], allowed_field_ids: [] });
    });

    it('enforces the saved-filter owner limit across concurrent inserts', async () => {
      if (!firstContext) {
        throw new Error('Integration access contexts were not initialized.');
      }
      const { error } = await client.from('saved_filter').insert(
        Array.from({ length: 255 }, (_, index) => ({
          portal_id: portalId,
          owner_id: firstUserId,
          name: `Concurrent limit ${index + 1}`,
          filter_payload: [],
        })),
      );
      expect(error).toBeNull();

      const results = await Promise.allSettled([
        repositories.createSavedFilter(firstContext, {
          name: 'Concurrent winner A',
          filterPayload: [],
        }),
        repositories.createSavedFilter(firstContext, {
          name: 'Concurrent winner B',
          filterPayload: [],
        }),
      ]);
      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');
      const { count, error: countError } = await client
        .from('saved_filter')
        .select('id', { count: 'exact', head: true })
        .eq('portal_id', portalId)
        .eq('owner_id', firstUserId);

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({ reason: { code: 'SAVED_FILTER_LIMIT' } });
      expect(countError).toBeNull();
      expect(count).toBe(256);
    });

    it('isolates operation history and atomically records concurrent task results', async () => {
      if (
        !firstContext ||
        !firstSystemContext ||
        !secondContext ||
        !secondSystemContext ||
        !secondViewAllContext
      ) {
        throw new Error('Integration access contexts were not initialized.');
      }
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
        repositories.startOperation(firstSystemContext, {
          operationId: operation.id,
          launchAttempt: operation.launchAttempt,
          correlationId: 'TC-123e4567-e89b-42d3-a456-426614174012',
        }),
      ).resolves.toMatchObject({ disposition: 'applied' });

      await expect(
        Promise.all([
          repositories.recordTaskResult(firstSystemContext, {
            operationId: operation.id,
            launchAttempt: operation.launchAttempt,
            taskId: '9001',
            title: 'First task',
            taskUrl: 'https://portal.bitrix24.ru/task/9001',
            outcome: 'success',
            requestedFieldIds: [],
            appliedFieldIds: [],
            failedFieldIds: [],
            reasonCode: null,
            reasonMessage: null,
            correlationId: null,
            canRetry: false,
          }),
          repositories.recordTaskResult(firstSystemContext, {
            operationId: operation.id,
            launchAttempt: operation.launchAttempt,
            taskId: '9002',
            title: 'Second task',
            taskUrl: 'https://portal.bitrix24.ru/task/9002',
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
        repositories.startOperation(secondSystemContext, {
          operationId: operation.id,
          launchAttempt: operation.launchAttempt,
          correlationId: 'TC-123e4567-e89b-42d3-a456-426614174011',
        }),
      ).rejects.toMatchObject({ code: 'UNAVAILABLE_RECORD' });
      await expect(
        repositories.recordTaskResult(secondSystemContext, {
          operationId: operation.id,
          launchAttempt: operation.launchAttempt,
          taskId: '9003',
          title: 'Unauthorized result',
          taskUrl: 'https://portal.bitrix24.ru/task/9003',
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
      await expect(repositories.listTaskResults(firstContext, operation.id)).resolves.toHaveLength(
        2,
      );
      await expect(repositories.getOperation(firstContext, operation.id)).resolves.toMatchObject({
        summary: expect.objectContaining({ successful: 1, failed: 1 }),
      });

      const noReportVisibility = createDataAccessContext(
        await resolveEffectiveAccess(
          await createVerifiedTestPrincipal({
            portalId,
            userId: secondUserId,
            displayName: 'Second integration operator',
            isBitrixAdmin: false,
          }),
          {
            findEffectiveAccessSettings: async () => ({
              accessActive: true,
              permissions: ['app_access'],
              allowedFieldIds: [],
              accessVersion: 1,
            }),
          },
        ),
      );
      await expect(
        repositories.getOperation(noReportVisibility, operation.id),
      ).rejects.toMatchObject({ code: 'UNAVAILABLE_RECORD' });
      await expect(repositories.listOperationHistory(noReportVisibility)).rejects.toMatchObject({
        code: 'UNAVAILABLE_RECORD',
      });
      await expect(
        repositories.findReportAuthorization({ portalId, operationId: operation.id }),
      ).resolves.toEqual({ ownerId: firstUserId });
      await expect(
        repositories.findReportAuthorization({
          portalId: `other-${portalId}`,
          operationId: operation.id,
        }),
      ).resolves.toBeNull();
    });
  });
}

if (!integrationEnabled) {
  describe.skip('Supabase data access integration', () => {
    it('requires an isolated configured database', () => undefined);
  });
}
