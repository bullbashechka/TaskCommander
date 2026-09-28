import { Hono } from 'hono';

import {
  bulkOperationDraftAvailabilitySchema,
  bulkOperationDraftSchema,
  confirmTaskPreflightRequestSchema,
  preflightPreviewSchema,
  saveBulkOperationDraftRequestSchema,
  taskChangeCatalogResponseSchema,
  taskPreflightRequestSchema,
  taskPreflightConfirmationSchema,
  type BulkOperationDraft,
  type PreflightPreview,
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
import { clientRateLimitKey, requireRateLimit } from '../http/security';
import { parseJsonBody } from '../http/validation';
import type { BitrixAdapter } from '../integrations/bitrix/contract';
import type { RuntimeEnvironment } from '../runtime/configuration';
import { configuredOrigins } from '../runtime/origin-policy';
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
import { buildTaskPreflight, TaskPreflightError } from './preflight';

export type TaskChangeRepository = Readonly<{
  ensurePrincipalIdentity(context: DataAccessContext, displayName: string): Promise<void>;
  getCurrentDraft(context: DataAccessContext): Promise<BulkOperationDraft | null>;
  getCurrentDraftForPreflight(context: DataAccessContext): Promise<{
    draft: BulkOperationDraft;
    preflightSnapshot: Json | null;
  } | null>;
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
  saveTaskPreflight(
    context: DataAccessContext,
    input: {
      draftId: string;
      expectedRevision: number;
      preflightSnapshot: Json;
    },
  ): Promise<{ draft: BulkOperationDraft; preflightSnapshot: Json }>;
  confirmTaskPreflight(
    context: DataAccessContext,
    input: {
      draftId: string;
      draftRevision: number;
      checkedAt: string;
      preflightSnapshot: Json;
      snapshotFingerprint: string;
    },
  ): Promise<unknown>;
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
    if (error.code === 'PREFLIGHT_TOO_LARGE') {
      throw new ApiHttpError(413, 'PREFLIGHT_TOO_LARGE');
    }
  }
  throw new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
}

function throwPreflightApiError(error: TaskPreflightError): never {
  switch (error.code) {
    case 'UNAUTHENTICATED':
      throw new ApiHttpError(401, 'UNAUTHENTICATED');
    case 'RATE_LIMITED':
      throw new ApiHttpError(429, 'RATE_LIMITED');
    case 'PREFLIGHT_TOO_LARGE':
      throw new ApiHttpError(413, 'PREFLIGHT_TOO_LARGE');
    case 'UPSTREAM_UNAVAILABLE':
      throw new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
  }
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function sameAccess(left: EffectiveAccess, right: EffectiveAccess): boolean {
  return (
    left.principal.portalId === right.principal.portalId &&
    left.principal.userId === right.principal.userId &&
    left.principal.isBitrixAdmin === right.principal.isBitrixAdmin &&
    left.accessVersion === right.accessVersion &&
    sameSet(left.permissions, right.permissions) &&
    left.fieldScope.kind === right.fieldScope.kind &&
    (left.fieldScope.kind === 'all' ||
      (right.fieldScope.kind === 'subset' &&
        sameSet(left.fieldScope.fieldIds, right.fieldScope.fieldIds)))
  );
}

function previewMatchesDraft(preview: PreflightPreview, draft: BulkOperationDraft): boolean {
  const fieldIds = draft.changes.map((change) => change.fieldId);
  return (
    preview.draftId === draft.id &&
    preview.sourceDraftRevision === draft.revision &&
    preview.draftRevision === draft.revision + 1 &&
    preview.entries.length === draft.selectedTaskIds.length &&
    preview.entries.every((entry, index) => {
      if (entry.taskId !== draft.selectedTaskIds[index]) return false;
      if (entry.changedFieldIds.some((fieldId) => !fieldIds.includes(fieldId))) return false;
      if (entry.currentValues === null || entry.targetValues === null) {
        return entry.currentValues === null && entry.targetValues === null;
      }
      return (
        sameSet(Object.keys(entry.currentValues), fieldIds) &&
        sameSet(Object.keys(entry.targetValues), fieldIds)
      );
    })
  );
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

  async function authorizePreflight(context: {
    env: RuntimeEnvironment;
    req: { header(name: string): string | undefined; raw: Request };
    get(name: 'correlationId'): string;
  }) {
    await requireRateLimit(
      context.env.ACCESS_FANOUT_RATE_LIMITER,
      `client:${clientRateLimitKey(context.req.raw)}:task-preflight`,
    );
    const authorization = await authorize(context);
    await requireRateLimit(
      context.env.ACCESS_FANOUT_RATE_LIMITER,
      `${authorization.principal.portalId}:${authorization.principal.userId}:task-preflight`,
    );
    return authorization;
  }

  function createAdapter(env: RuntimeEnvironment, currentUserId: string): BitrixAdapter {
    try {
      return dependencies.createAdapter(env, { currentUserId });
    } catch {
      throw new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
    }
  }

  async function loadCapabilities(adapter: BitrixAdapter) {
    try {
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
    const adapter = createAdapter(context.env, principal.userId);
    const capabilities = await loadCapabilities(adapter);
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
    const adapter = createAdapter(context.env, principal.userId);
    const capabilities = await loadCapabilities(adapter);
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

  routes.post('/preflight', async (context) => {
    const authorization = await authorizePreflight(context);
    if (!authorization.principal.isBitrixAdmin && authorization.access.accessVersion === null) {
      throw new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
    }
    const input = await parseJsonBody(context.req.raw, taskPreflightRequestSchema, 4_096);
    const repository = dependencies.createRepository(context.env);
    let current: Awaited<ReturnType<TaskChangeRepository['getCurrentDraftForPreflight']>>;
    try {
      current = await repository.getCurrentDraftForPreflight(authorization.dataContext);
    } catch (error) {
      throwDataApiError(error);
    }
    if (!current || current.draft.id !== input.draftId) {
      throw new ApiHttpError(409, 'CONFLICT');
    }
    if (current.draft.revision === input.expectedRevision + 1) {
      const existing = preflightPreviewSchema.safeParse(current.preflightSnapshot);
      if (
        !existing.success ||
        existing.data.draftId !== input.draftId ||
        existing.data.sourceDraftRevision !== input.expectedRevision ||
        existing.data.actorAccessVersion !== authorization.access.accessVersion ||
        !previewMatchesDraft(existing.data, {
          ...current.draft,
          revision: input.expectedRevision,
        })
      ) {
        throw new ApiHttpError(409, 'CONFLICT');
      }
      return context.json(existing.data);
    }
    if (current.draft.revision !== input.expectedRevision) {
      throw new ApiHttpError(409, 'CONFLICT');
    }

    const adapter = createAdapter(context.env, authorization.principal.userId);
    const capabilities = await loadCapabilities(adapter);
    const catalog = createTaskChangeCatalog(capabilities, authorization.access.fieldScope);
    try {
      requireValidTaskSearchDefinition(current.draft, createTaskFilterCatalog(capabilities));
      requireValidBulkChanges(current.draft.changes, catalog);
    } catch (error) {
      if (
        error instanceof InvalidTaskChangeDefinitionError ||
        error instanceof InvalidTaskSearchDefinitionError
      ) {
        throw new ApiHttpError(400, 'INVALID_REQUEST');
      }
      throw error;
    }

    let preview: PreflightPreview;
    try {
      preview = await buildTaskPreflight({
        adapter,
        draft: current.draft,
        catalog,
        actorAccessVersion: authorization.access.accessVersion,
        trustedPortalOrigins: configuredOrigins(
          context.env.BITRIX_PORTAL_ORIGIN,
          context.env.APP_ENV === 'local',
        ),
      });
    } catch (error) {
      if (error instanceof TaskPreflightError) throwPreflightApiError(error);
      throw new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
    }

    if (!previewMatchesDraft(preview, current.draft)) {
      throw new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
    }

    const renewed = await authorize(context);
    if (!sameAccess(authorization.access, renewed.access)) {
      throw new ApiHttpError(409, 'CONFLICT');
    }
    try {
      const saved = await repository.saveTaskPreflight(renewed.dataContext, {
        draftId: input.draftId,
        expectedRevision: input.expectedRevision,
        preflightSnapshot: asJson(preview),
      });
      const stored = preflightPreviewSchema.parse(saved.preflightSnapshot);
      if (
        stored.draftRevision !== saved.draft.revision ||
        stored.actorAccessVersion !== renewed.access.accessVersion ||
        !previewMatchesDraft(stored, current.draft)
      ) {
        throw new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
      }
      return context.json(stored);
    } catch (error) {
      if (error instanceof ApiHttpError) throw error;
      throwDataApiError(error);
    }
  });

  routes.post('/preflight/confirm', async (context) => {
    const { access, dataContext } = await authorizePreflight(context);
    if (!dataContext.isBitrixAdmin && access.accessVersion === null) {
      throw new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
    }
    const input = await parseJsonBody(context.req.raw, confirmTaskPreflightRequestSchema, 4_096);
    const repository = dependencies.createRepository(context.env);
    try {
      const current = await repository.getCurrentDraftForPreflight(dataContext);
      if (
        !current ||
        current.draft.id !== input.draftId ||
        current.draft.revision !== input.draftRevision ||
        current.draft.status !== 'awaiting_confirmation'
      ) {
        throw new ApiHttpError(409, 'CONFLICT');
      }
      const parsed = preflightPreviewSchema.safeParse(current.preflightSnapshot);
      if (
        !parsed.success ||
        parsed.data.checkedAt !== input.checkedAt ||
        parsed.data.draftRevision !== input.draftRevision ||
        parsed.data.actorAccessVersion !== access.accessVersion ||
        !parsed.data.canProceed ||
        !previewMatchesDraft(parsed.data, {
          ...current.draft,
          revision: input.draftRevision - 1,
        })
      ) {
        throw new ApiHttpError(409, 'CONFLICT');
      }
      const confirmed = await repository.confirmTaskPreflight(dataContext, {
        ...input,
        preflightSnapshot: asJson(parsed.data),
        snapshotFingerprint: Array.from(
          new Uint8Array(
            await crypto.subtle.digest(
              'SHA-256',
              new TextEncoder().encode(JSON.stringify(parsed.data)),
            ),
          ),
          (byte) => byte.toString(16).padStart(2, '0'),
        ).join(''),
      });
      return context.json(taskPreflightConfirmationSchema.parse(confirmed));
    } catch (error) {
      if (error instanceof ApiHttpError) throw error;
      throwDataApiError(error);
    }
  });

  return routes;
}
