import { Hono } from 'hono';

import {
  bulkOperationDraftAvailabilitySchema,
  bulkOperationDraftSchema,
  saveBulkOperationDraftRequestSchema,
  taskChangeCatalogResponseSchema,
  type BulkOperationDraft,
} from '@task-commander/contracts';

import type { VerifiedSessionPrincipal } from '../auth/session-service';
import {
  createDataAccessContext,
  EffectiveAccessError,
  requireAllPermissions,
  type DataAccessContext,
  type EffectiveAccess,
} from '../data/access';
import type { Json } from '../data/database.types';
import { DataAccessError } from '../data/errors';
import { ApiHttpError } from '../http/errors';
import { parseJsonBody } from '../http/validation';
import type { BitrixAdapter } from '../integrations/bitrix/contract';
import type { RuntimeEnvironment } from '../runtime/configuration';
import {
  createTaskFilterCatalog,
  InvalidTaskSearchDefinitionError,
  requireValidTaskSearchDefinition,
} from '../task-filters/catalog';
import { toTaskFilterBitrixApiError } from '../task-filters/errors';
import {
  createTaskChangeCatalog,
  InvalidTaskChangeDefinitionError,
  requireValidBulkChanges,
} from './catalog';

export type TaskChangeRepository = Readonly<{
  ensurePrincipalIdentity(context: DataAccessContext, displayName: string): Promise<void>;
  getCurrentDraft(context: DataAccessContext): Promise<BulkOperationDraft | null>;
  saveDraft(
    context: DataAccessContext,
    input: {
      expectedRevision: number;
      status: BulkOperationDraft['status'];
      filterSnapshot: Json | null;
      sortSnapshot: Json | null;
      selectedTaskIds: string[];
      changes: Json;
      preflightSnapshot: Json | null;
      replaceExpired?: boolean;
    },
  ): Promise<BulkOperationDraft>;
}>;

export type TaskChangeRouteDependencies = Readonly<{
  readPrincipal(
    env: RuntimeEnvironment,
    cookie: string | null,
    correlationId: string,
  ): Promise<VerifiedSessionPrincipal>;
  readEffectiveAccess(
    env: RuntimeEnvironment,
    principal: VerifiedSessionPrincipal,
  ): Promise<EffectiveAccess>;
  createAdapter(env: RuntimeEnvironment, input: { currentUserId: string }): BitrixAdapter;
  createRepository(env: RuntimeEnvironment): TaskChangeRepository;
}>;

type Variables = { correlationId: string };

function asJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

function toAuthorizationApiError(error: EffectiveAccessError): ApiHttpError {
  switch (error.kind) {
    case 'forbidden':
      return new ApiHttpError(403, 'FORBIDDEN');
    case 'not_found':
      return new ApiHttpError(404, 'NOT_FOUND');
    case 'upstream_unavailable':
      return new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
  }
}

function throwDataApiError(error: unknown): never {
  if (error instanceof DataAccessError) {
    if (error.code === 'CONFLICT') throw new ApiHttpError(409, 'CONFLICT');
    if (error.code === 'RATE_LIMITED') throw new ApiHttpError(429, 'RATE_LIMITED');
  }
  throw new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
}

export function createTaskChangeRoutes(dependencies: TaskChangeRouteDependencies) {
  const routes = new Hono<{ Bindings: RuntimeEnvironment; Variables: Variables }>();

  async function authorize(context: {
    env: RuntimeEnvironment;
    req: { header(name: string): string | undefined };
    get(name: 'correlationId'): string;
  }) {
    const principal = await dependencies.readPrincipal(
      context.env,
      context.req.header('cookie') ?? null,
      context.get('correlationId'),
    );
    try {
      const access = await dependencies.readEffectiveAccess(context.env, principal);
      requireAllPermissions(access, ['app_access', 'run_bulk_operations', 'change_allowed_fields']);
      return { principal, access, dataContext: createDataAccessContext(access) };
    } catch (error) {
      if (error instanceof EffectiveAccessError) throw toAuthorizationApiError(error);
      throw error;
    }
  }

  async function loadCapabilities(env: RuntimeEnvironment, principal: VerifiedSessionPrincipal) {
    try {
      const adapter = dependencies.createAdapter(env, { currentUserId: principal.userId });
      const result = await adapter.tasks.getFieldCapabilities();
      if (!result.ok) throw toTaskFilterBitrixApiError(result.failure);
      return result.value;
    } catch (error) {
      if (error instanceof ApiHttpError) throw error;
      throw new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
    }
  }

  routes.get('/change-fields', async (context) => {
    const { principal, access } = await authorize(context);
    const capabilities = await loadCapabilities(context.env, principal);
    return context.json(
      taskChangeCatalogResponseSchema.parse(
        createTaskChangeCatalog(capabilities, access.fieldScope),
      ),
    );
  });

  routes.get('/draft', async (context) => {
    const { dataContext } = await authorize(context);
    try {
      const draft = await dependencies.createRepository(context.env).getCurrentDraft(dataContext);
      return context.json(bulkOperationDraftAvailabilitySchema.parse({ draft }));
    } catch (error) {
      throwDataApiError(error);
    }
  });

  routes.put('/draft', async (context) => {
    const { principal, access, dataContext } = await authorize(context);
    const input = await parseJsonBody(
      context.req.raw,
      saveBulkOperationDraftRequestSchema,
      131_072,
    );
    const capabilities = await loadCapabilities(context.env, principal);
    try {
      requireValidTaskSearchDefinition(input, createTaskFilterCatalog(capabilities));
      requireValidBulkChanges(
        input.changes,
        createTaskChangeCatalog(capabilities, access.fieldScope),
      );
      const repository = dependencies.createRepository(context.env);
      if (principal.isBitrixAdmin) {
        await repository.ensurePrincipalIdentity(dataContext, principal.displayName);
      }
      const saved = await repository.saveDraft(dataContext, {
        expectedRevision: input.expectedRevision,
        status: 'preparing',
        filterSnapshot: asJson({ filters: input.filters }),
        sortSnapshot: asJson(input.sort),
        selectedTaskIds: input.selectedTaskIds,
        changes: asJson(input.changes),
        preflightSnapshot: null,
        replaceExpired: input.replaceExpired,
      });
      return context.json(bulkOperationDraftSchema.parse(saved));
    } catch (error) {
      if (
        error instanceof InvalidTaskChangeDefinitionError ||
        error instanceof InvalidTaskSearchDefinitionError
      ) {
        throw new ApiHttpError(400, 'INVALID_REQUEST');
      }
      if (error instanceof ApiHttpError) throw error;
      throwDataApiError(error);
    }
  });

  return routes;
}
