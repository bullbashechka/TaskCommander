import { Hono } from 'hono';
import { z } from 'zod';

import {
  bulkOperationDraftAvailabilitySchema,
  bulkOperationDraftSchema,
  bulkChangeCommandSchema,
  restoreSourceAvailabilitySchema,
  prepareRestoreDraftRequestSchema,
  retryDraftRecoveryAvailabilitySchema,
  retryDraftRecoverySchema,
  confirmTaskPreflightRequestSchema,
  launchTaskPreflightRequestSchema,
  operationIdSchema,
  bulkOperationSchema,
  operationProgressSchema,
  operationProgressResultsPageSchema,
  currentOperationProgressSchema,
  preflightPreviewSchema,
  saveBulkOperationDraftRequestSchema,
  taskChangeCatalogResponseSchema,
  taskPreflightRequestSchema,
  taskPreflightConfirmationSchema,
  type BulkOperationDraft,
  type BulkOperation,
  type OperationProgress,
  type OperationProgressResultsPage,
  type PreflightPreview,
  type TaskOutcome,
  type RetryTaskIntent,
  type TaskChangeValue,
  type BulkChangeCommand,
  type RestoreTaskIntentMetadata,
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
import {
  decryptExecutionPlan, encryptExecutionPlan, decryptPreviousValues,
  encryptPrivateRestoreData, decryptPrivateRestoreData, type RestoreTaskIntent,
} from './execution-plan';
import { dispatchOperationLaunch } from './dispatch';

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
  findOperationByLaunchKey(
    context: DataAccessContext,
    key: string,
    expected: { draftId: string; draftRevision: number; checkedAt: string },
  ): Promise<BulkOperation | null>;
  readConfirmedOperationReceipt(
    context: DataAccessContext,
    operationId: string,
  ): Promise<BulkOperation>;
  getOwnedOperationProgress(
    context: DataAccessContext,
    operationId: string,
  ): Promise<BulkOperation>;
  getLatestOwnedOperationProgress(context: DataAccessContext): Promise<BulkOperation | null>;
  readRetrySource(
    context: DataAccessContext,
    operationId: string,
  ): Promise<{
    operation: BulkOperation;
    plan: { ciphertext: string; nonce: string; keyVersion: string; payloadVersion: number };
    token: string;
    draftId: string;
    draftRevision: number;
  }>;
  listTaskResults(context: DataAccessContext, operationId: string): Promise<TaskOutcome[]>;
  saveRetryDraft(
    context: DataAccessContext,
    input: {
      sourceOperationId: string;
      sourceStateVersion: number;
      selectedTaskIds: string[];
      changes: Json;
      intents: RetryTaskIntent[];
    },
  ): Promise<BulkOperationDraft>;
  readRestoreSource(context: DataAccessContext, operationId: string): Promise<{
    operationId: string; ownerId: string; stateVersion: number;
    tasks: Array<{
      taskId: string; title: string | null; taskUrl: string | null;
      appliedFieldIds: string[]; ciphertext: string; nonce: string;
      keyVersion: string; payloadVersion: number; beforeVersion: string; afterVersion: string;
    }>;
  }>;
  saveRestoreDraft(context: DataAccessContext, input: {
    draftId: string; sourceOperationId: string; sourceStateVersion: number;
    selectedTaskIds: string[]; changes: Json; intents: RestoreTaskIntentMetadata[];
    encryptedIntents: { ciphertext: string; nonce: string };
  }): Promise<BulkOperationDraft>;
  readPrivateRestoreDraft(context: DataAccessContext, draftId: string): Promise<{
    intentCiphertext: string; intentNonce: string; previewCiphertext: string | null;
    previewNonce: string | null; previewRevision: number | null;
    previewFingerprint: string | null; keyVersion: string;
  }>;
  saveRestorePreflight(context: DataAccessContext, input: {
    draftId: string; expectedRevision: number; safeSnapshot: Json;
    encryptedPreview: { ciphertext: string; nonce: string }; fullFingerprint: string;
  }): Promise<BulkOperationDraft>;
  launchConfirmedRestorePreflight(context: DataAccessContext, input: {
    displayName: string; draftId: string; draftRevision: number; checkedAt: string;
    token: string | null; safeSnapshot: Json; safeFingerprint: string;
    fullFingerprint: string;
    encryptedPlan: { ciphertext: string; nonce: string; keyVersion: string } | null;
    correlationId: string;
  }): Promise<{ disposition: string; operation: BulkOperation }>;
  getRetryDraftRecovery(
    context: DataAccessContext,
  ): Promise<{ draftId: string; revision: number } | null>;
  discardRetryDraft(
    context: DataAccessContext,
    input: { draftId: string; revision: number },
  ): Promise<boolean>;
  listOwnedOperationProgressResults(
    context: DataAccessContext,
    operationId: string,
    request: { cursor?: string; limit?: number },
  ): Promise<{ items: TaskOutcome[]; nextCursor: string | null }>;
  requestOperationCancellation(
    context: DataAccessContext,
    input: { operationId: string; correlationId: string },
  ): Promise<{ operation: BulkOperation }>;
  launchConfirmedTaskPreflight(
    context: DataAccessContext,
    input: {
      displayName: string;
      draftId: string;
      draftRevision: number;
      checkedAt: string;
      token: string | null;
      preflightSnapshot: Json;
      snapshotFingerprint: string;
      encryptedPlan: { ciphertext: string; nonce: string; keyVersion: string } | null;
      correlationId: string;
    },
  ): Promise<{ disposition: string; operation: BulkOperation }>;
  claimOperationLaunchDispatch(
    portalId: string,
    operationId: string,
  ): Promise<{
    operation_id: string;
    portal_id: string;
    launch_attempt: number;
    message_id: string;
    status: string;
    created_at: string;
    dispatched_at: string | null;
    claim_id: string | null;
  } | null>;
  completeOperationLaunchDispatch(input: {
    portalId: string;
    operationId: string;
    launchAttempt: number;
    messageId: string;
    claimId: string;
    sent: boolean;
    correlationId: string;
  }): Promise<void>;
  retryConfirmedOperationLaunch(
    context: DataAccessContext,
    operationId: string,
    correlationId: string,
  ): Promise<{ disposition: string; operation: BulkOperation }>;
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
  createAdapter(
    env: RuntimeEnvironment,
    input: { currentUserId: string; portalId?: string },
  ): BitrixAdapter;
  createRepository(env: RuntimeEnvironment): TaskChangeRepository;
}>;

type Variables = { correlationId: string };
const launchRetryEmptyRequestSchema = z.object({}).strict();
const progressResultsQuerySchema = z
  .object({
    cursor: z.string().min(1).max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

function toProgress(operation: BulkOperation): OperationProgress {
  const summary = operation.summary;
  const processed =
    summary.successful +
    summary.failed +
    summary.unconfirmed +
    summary.conflicted +
    summary.partiallyApplied +
    summary.notProcessed;
  if (processed > summary.eligible) throw new DataAccessError('INTEGRITY', false);
  return operationProgressSchema.parse({
    operation,
    processed,
    remaining: summary.eligible - processed,
    percent:
      summary.eligible === 0
        ? 100
        : Math.min(100, Math.floor((processed * 100) / summary.eligible)),
  });
}

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
    if (
      error.code === 'CONFLICT' ||
      error.code === 'ACTIVE_OPERATION' ||
      error.code === 'INVALID_OPERATION_STATE'
    )
      throw new ApiHttpError(409, 'CONFLICT');
    if (error.code === 'UNAVAILABLE_RECORD') throw new ApiHttpError(404, 'NOT_FOUND');
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

function fieldsWithinScope(access: EffectiveAccess, fieldIds: readonly string[]): boolean {
  const scope = access.fieldScope;
  return scope.kind === 'all' || fieldIds.every((fieldId) => scope.fieldIds.includes(fieldId));
}

async function snapshotFingerprint(value: unknown): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function safeRestorePreview(preview: PreflightPreview): PreflightPreview {
  return preflightPreviewSchema.parse({
    ...preview,
    entries: preview.entries.map((entry) => ({
      ...entry,
      currentValues: null,
      targetValues: null,
      ...(entry.disposition === 'eligible' || entry.disposition === 'no_change'
        ? { valuesOmitted: true }
        : {}),
    })),
  });
}

function previewMatchesDraft(preview: PreflightPreview, draft: BulkOperationDraft): boolean {
  const fieldIds = draft.changes.map((change) => change.fieldId);
  return (
    preview.draftId === draft.id &&
    preview.sourceDraftRevision === draft.revision &&
    preview.draftRevision === draft.revision + 1 &&
    preview.entries.length === draft.selectedTaskIds.length &&
    preview.entries.every((entry, index) => {
      const expectedFieldIds = draft.restoreIntents
        ? draft.restoreIntents[index]?.fieldIds ?? []
        : draft.retryIntents
        ? Object.keys(draft.retryIntents[index]?.targetValues ?? {})
        : fieldIds;
      if (entry.taskId !== draft.selectedTaskIds[index]) return false;
      if (entry.changedFieldIds.some((fieldId) => !expectedFieldIds.includes(fieldId)))
        return false;
      if (entry.valuesOmitted && draft.restoreIntents) return true;
      if (entry.currentValues === null || entry.targetValues === null) {
        return entry.currentValues === null && entry.targetValues === null;
      }
      return (
        sameSet(Object.keys(entry.currentValues), expectedFieldIds) &&
        sameSet(Object.keys(entry.targetValues), expectedFieldIds)
      );
    })
  );
}

export function createTaskChangeRoutes(dependencies: TaskChangeRouteDependencies) {
  const routes = new Hono<{ Bindings: RuntimeEnvironment; Variables: Variables }>();

  async function requireRetrySourceCurrent(
    repository: TaskChangeRepository,
    dataContext: DataAccessContext,
    access: EffectiveAccess,
    draft: BulkOperationDraft,
  ): Promise<void> {
    if (!draft.retrySourceOperationId) return;
    if (!draft.retrySourceStateVersion) throw new ApiHttpError(409, 'CONFLICT');
    const fieldIds =
      draft.retryIntents?.flatMap((intent) => Object.keys(intent.targetValues)) ?? [];
    if (!access.permissions.includes('retry_operations') || !fieldsWithinScope(access, fieldIds))
      throw new ApiHttpError(409, 'CONFLICT');
    try {
      const source = await repository.readRetrySource(dataContext, draft.retrySourceOperationId);
      if (source.operation.stateVersion !== draft.retrySourceStateVersion)
        throw new ApiHttpError(409, 'CONFLICT');
    } catch (error) {
      if (error instanceof ApiHttpError) throw error;
      if (
        error instanceof DataAccessError &&
        (error.code === 'UNAVAILABLE_RECORD' || error.code === 'CONFLICT')
      )
        throw new ApiHttpError(409, 'CONFLICT');
      throwDataApiError(error);
    }
  }

  async function requireRestoreSourceCurrent(
    repository: TaskChangeRepository,
    dataContext: DataAccessContext,
    access: EffectiveAccess,
    draft: BulkOperationDraft,
  ) {
    if (!draft.restoreSourceOperationId) return null;
    if (!draft.restoreSourceStateVersion || !draft.restoreIntents ||
      !access.permissions.includes('restore_operations') ||
      !fieldsWithinScope(access, draft.restoreIntents.flatMap((intent) => intent.fieldIds))) {
      throw new ApiHttpError(409, 'CONFLICT');
    }
    try {
      return await repository.readPrivateRestoreDraft(dataContext, draft.id);
    } catch (error) {
      if (error instanceof DataAccessError &&
        (error.code === 'UNAVAILABLE_RECORD' || error.code === 'CONFLICT')) {
        throw new ApiHttpError(409, 'CONFLICT');
      }
      throwDataApiError(error);
    }
  }

  async function readRestoreIntents(
    env: RuntimeEnvironment, principal: VerifiedSessionPrincipal,
    draft: BulkOperationDraft,
    privateDraft: NonNullable<Awaited<ReturnType<typeof requireRestoreSourceCurrent>>>,
  ): Promise<RestoreTaskIntent[]> {
    const result = await decryptPrivateRestoreData({
      keyBase64: env.OPERATION_PLAN_KEY_V1, portalId: principal.portalId,
      ownerId: principal.userId, draftId: draft.id,
      sourceOperationId: draft.restoreSourceOperationId!,
      sourceStateVersion: draft.restoreSourceStateVersion!, revision: 1,
      purpose: 'intents', ciphertext: privateDraft.intentCiphertext,
      nonce: privateDraft.intentNonce, keyVersion: privateDraft.keyVersion,
    });
    if (!Array.isArray(result) || result.length !== draft.selectedTaskIds.length ||
      result.some((intent, index) => intent.taskId !== draft.selectedTaskIds[index] ||
        !sameSet(intent.fieldIds, draft.restoreIntents?.[index]?.fieldIds ?? []) ||
        intent.afterVersion !== draft.restoreIntents?.[index]?.afterVersion ||
        !sameSet(Object.keys(intent.targetValues), intent.fieldIds))) {
      throw new ApiHttpError(409, 'CONFLICT');
    }
    return result;
  }

  async function readRestorePreview(
    env: RuntimeEnvironment, principal: VerifiedSessionPrincipal,
    draft: BulkOperationDraft,
    privateDraft: NonNullable<Awaited<ReturnType<typeof requireRestoreSourceCurrent>>>,
    safeSnapshot: Json | null,
  ): Promise<PreflightPreview> {
    if (!privateDraft.previewCiphertext || !privateDraft.previewNonce ||
      privateDraft.previewRevision !== draft.revision || !privateDraft.previewFingerprint) {
      throw new ApiHttpError(409, 'CONFLICT');
    }
    const value = await decryptPrivateRestoreData({
      keyBase64: env.OPERATION_PLAN_KEY_V1, portalId: principal.portalId,
      ownerId: principal.userId, draftId: draft.id,
      sourceOperationId: draft.restoreSourceOperationId!,
      sourceStateVersion: draft.restoreSourceStateVersion!, revision: draft.revision,
      purpose: 'preview', ciphertext: privateDraft.previewCiphertext,
      nonce: privateDraft.previewNonce, keyVersion: privateDraft.keyVersion,
    });
    if (Array.isArray(value) ||
      await snapshotFingerprint(value) !== privateDraft.previewFingerprint ||
      canonicalJson(safeRestorePreview(value)) !== canonicalJson(safeSnapshot)) {
      throw new ApiHttpError(409, 'CONFLICT');
    }
    return value;
  }

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

  async function authorizeProgress(context: {
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
      if (
        !(['run_bulk_operations', 'view_own_reports', 'view_all_reports'] as const).some(
          (permission) => access.permissions.includes(permission),
        )
      ) {
        throw new ApiHttpError(403, 'FORBIDDEN');
      }
      return { principal, access, dataContext: createDataAccessContext(access) };
    } catch (error) {
      if (error instanceof EffectiveAccessError) throw toAuthorizationApiError(error);
      throw error;
    }
  }

  function createAdapter(
    env: RuntimeEnvironment,
    currentUserId: string,
    portalId: string,
  ): BitrixAdapter {
    try {
      return dependencies.createAdapter(env, { currentUserId, portalId });
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
    const adapter = createAdapter(context.env, principal.userId, principal.portalId);
    const capabilities = await loadCapabilities(adapter);
    return context.json(
      taskChangeCatalogResponseSchema.parse(
        createTaskChangeCatalog(capabilities, access.fieldScope),
      ),
    );
  });

  routes.get('/draft', async (context) => {
    const { access, dataContext } = await authorize(context);
    try {
      const repository = dependencies.createRepository(context.env);
      const draft = await repository.getCurrentDraft(dataContext);
      if (draft?.retrySourceOperationId)
        await requireRetrySourceCurrent(repository, dataContext, access, draft);
      if (draft?.restoreSourceOperationId)
        await requireRestoreSourceCurrent(repository, dataContext, access, draft);
      return context.json(bulkOperationDraftAvailabilitySchema.parse({ draft }));
    } catch (error) {
      if (error instanceof ApiHttpError) throw error;
      throwDataApiError(error);
    }
  });

  routes.get('/draft/retry-recovery', async (context) => {
    const { dataContext } = await authorize(context);
    try {
      const retryDraft = await dependencies
        .createRepository(context.env)
        .getRetryDraftRecovery(dataContext);
      return context.json(retryDraftRecoveryAvailabilitySchema.parse({ retryDraft }));
    } catch (error) {
      throwDataApiError(error);
    }
  });

  routes.delete('/draft/retry-recovery', async (context) => {
    const { dataContext } = await authorize(context);
    const input = await parseJsonBody(context.req.raw, retryDraftRecoverySchema, 256);
    try {
      const discarded = await dependencies
        .createRepository(context.env)
        .discardRetryDraft(dataContext, input);
      if (!discarded) throw new ApiHttpError(409, 'CONFLICT');
      return context.json(retryDraftRecoveryAvailabilitySchema.parse({ retryDraft: null }));
    } catch (error) {
      if (error instanceof ApiHttpError) throw error;
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
    const adapter = createAdapter(context.env, principal.userId, principal.portalId);
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
    await requireRetrySourceCurrent(
      repository,
      authorization.dataContext,
      authorization.access,
      current.draft,
    );
    const restorePrivate = await requireRestoreSourceCurrent(
      repository, authorization.dataContext, authorization.access, current.draft,
    );
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

    const adapter = createAdapter(
      context.env,
      authorization.principal.userId,
      authorization.principal.portalId,
    );
    const capabilities = await loadCapabilities(adapter);
    const catalog = createTaskChangeCatalog(capabilities, authorization.access.fieldScope);
    try {
      requireValidTaskSearchDefinition(current.draft, createTaskFilterCatalog(capabilities));
      if (!current.draft.retryIntents && !current.draft.restoreIntents)
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
    const restoreIntents = restorePrivate
      ? await readRestoreIntents(context.env, authorization.principal, current.draft, restorePrivate)
      : undefined;
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
        restoreIntents,
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
    await requireRetrySourceCurrent(repository, renewed.dataContext, renewed.access, current.draft);
    if (restorePrivate)
      await requireRestoreSourceCurrent(repository, renewed.dataContext, renewed.access, current.draft);
    try {
      const safePreview = restorePrivate ? safeRestorePreview(preview) : preview;
      const saved = restorePrivate
        ? {
            draft: await repository.saveRestorePreflight(renewed.dataContext, {
              draftId: input.draftId, expectedRevision: input.expectedRevision,
              safeSnapshot: asJson(safePreview),
              encryptedPreview: await encryptPrivateRestoreData({
                keyBase64: context.env.OPERATION_PLAN_KEY_V1,
                portalId: authorization.principal.portalId,
                ownerId: authorization.principal.userId, draftId: current.draft.id,
                sourceOperationId: current.draft.restoreSourceOperationId!,
                sourceStateVersion: current.draft.restoreSourceStateVersion!,
                revision: current.draft.revision + 1, purpose: 'preview', value: preview,
              }),
              fullFingerprint: await snapshotFingerprint(preview),
            }),
            preflightSnapshot: asJson(safePreview),
          }
        : await repository.saveTaskPreflight(renewed.dataContext, {
            draftId: input.draftId, expectedRevision: input.expectedRevision,
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
    const { principal, access, dataContext } = await authorizePreflight(context);
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
      await requireRetrySourceCurrent(repository, dataContext, access, current.draft);
      const restorePrivate = await requireRestoreSourceCurrent(repository, dataContext, access, current.draft);
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
      if (restorePrivate)
        await readRestorePreview(context.env, principal,
          current.draft, restorePrivate, current.preflightSnapshot);
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

  routes.post('/preflight/launch', async (context) => {
    const { principal, access, dataContext } = await authorizePreflight(context);
    if (!dataContext.isBitrixAdmin && access.accessVersion === null) {
      throw new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
    }
    const input = await parseJsonBody(context.req.raw, launchTaskPreflightRequestSchema, 4_096);
    const repository = dependencies.createRepository(context.env);
    const key =
      input.token === null
        ? `zero:${input.draftId}:${input.draftRevision}`
        : `confirmation:${input.token}`;
    try {
      const existing = await repository.findOperationByLaunchKey(dataContext, key, {
        draftId: input.draftId,
        draftRevision: input.draftRevision,
        checkedAt: input.checkedAt,
      });
      if (existing) {
        if (existing.status === 'launching') {
          try {
            await dispatchOperationLaunch({
              env: context.env,
              repository,
              portalId: principal.portalId,
              operationId: existing.id,
              correlationId: context.get('correlationId'),
            });
          } catch {
            // The original launch remains durable even if publication fails again.
          }
        }
        return context.json(
          bulkOperationSchema.parse(
            await repository.readConfirmedOperationReceipt(dataContext, existing.id),
          ),
        );
      }
      const current = await repository.getCurrentDraftForPreflight(dataContext);
      if (
        !current ||
        current.draft.id !== input.draftId ||
        current.draft.revision !== input.draftRevision ||
        current.draft.status !== 'awaiting_confirmation'
      ) {
        throw new ApiHttpError(409, 'CONFLICT');
      }
      await requireRetrySourceCurrent(repository, dataContext, access, current.draft);
      const restorePrivate = await requireRestoreSourceCurrent(repository, dataContext, access, current.draft);
      const parsed = preflightPreviewSchema.safeParse(current.preflightSnapshot);
      if (
        !parsed.success ||
        parsed.data.checkedAt !== input.checkedAt ||
        parsed.data.draftRevision !== input.draftRevision ||
        parsed.data.actorAccessVersion !== access.accessVersion ||
        parsed.data.canProceed !== (input.token !== null) ||
        !previewMatchesDraft(parsed.data, { ...current.draft, revision: input.draftRevision - 1 })
      ) {
        throw new ApiHttpError(409, 'CONFLICT');
      }
      const fullPreview = restorePrivate
        ? await readRestorePreview(context.env, principal, current.draft, restorePrivate,
          current.preflightSnapshot)
        : parsed.data;
      const restoreIntents = restorePrivate
        ? await readRestoreIntents(context.env, principal, current.draft, restorePrivate)
        : undefined;
      const fingerprint = Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(JSON.stringify(parsed.data)),
          ),
        ),
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join('');
      const encryptedPlan =
        input.token === null
          ? null
          : await encryptExecutionPlan({
              keyBase64: (context.env as RuntimeEnvironment & { OPERATION_PLAN_KEY_V1?: string })
                .OPERATION_PLAN_KEY_V1,
              portalId: principal.portalId,
              ownerId: principal.userId,
              token: input.token,
              draft: current.draft,
              preview: fullPreview,
              restoreIntents,
            });
      const latestAccess = await dependencies.readEffectiveAccess(context.env, principal);
      if (!sameAccess(access, latestAccess)) throw new ApiHttpError(409, 'CONFLICT');
      const launchInput = {
        displayName: principal.displayName, draftId: input.draftId,
        draftRevision: input.draftRevision, checkedAt: input.checkedAt,
        token: input.token, encryptedPlan, correlationId: context.get('correlationId'),
      };
      const launched = restorePrivate
        ? await repository.launchConfirmedRestorePreflight(dataContext, {
            ...launchInput, safeSnapshot: asJson(parsed.data), safeFingerprint: fingerprint,
            fullFingerprint: restorePrivate.previewFingerprint!,
          })
        : await repository.launchConfirmedTaskPreflight(dataContext, {
            ...launchInput, preflightSnapshot: asJson(parsed.data),
            snapshotFingerprint: fingerprint,
          });
      if (launched.operation.status === 'launching') {
        try {
          await dispatchOperationLaunch({
            env: context.env,
            repository,
            portalId: principal.portalId,
            operationId: launched.operation.id,
            correlationId: context.get('correlationId'),
          });
        } catch {
          // The database outbox retains an unsent or ambiguous send for recovery.
        }
      }
      return context.json(
        bulkOperationSchema.parse(
          await repository.readConfirmedOperationReceipt(dataContext, launched.operation.id),
        ),
      );
    } catch (error) {
      if (error instanceof ApiHttpError) throw error;
      throwDataApiError(error);
    }
  });

  routes.post('/operations/:operationId/retry-draft', async (context) => {
    const { principal, access, dataContext } = await authorizePreflight(context);
    if (
      !access.permissions.includes('retry_operations') ||
      !access.permissions.some(
        (permission) => permission === 'view_own_reports' || permission === 'view_all_reports',
      )
    )
      throw new ApiHttpError(403, 'FORBIDDEN');
    const operationId = context.req.param('operationId');
    if (!operationIdSchema.safeParse(operationId).success) throw new ApiHttpError(404, 'NOT_FOUND');
    await parseJsonBody(context.req.raw, launchRetryEmptyRequestSchema, 128);
    const repository = dependencies.createRepository(context.env);
    try {
      const source = await repository.readRetrySource(dataContext, operationId);
      if (
        source.operation.initiatorId === principal.userId
          ? !access.permissions.includes('view_own_reports')
          : !access.permissions.includes('view_all_reports')
      )
        throw new ApiHttpError(403, 'FORBIDDEN');
      if (source.plan.payloadVersion !== 1) throw new ApiHttpError(409, 'CONFLICT');
      const plan = await decryptExecutionPlan({
        keyBase64: context.env.OPERATION_PLAN_KEY_V1,
        portalId: principal.portalId,
        ownerId: source.operation.initiatorId,
        draftId: source.draftId,
        draftRevision: source.draftRevision,
        token: source.token,
        ...source.plan,
      });
      const results = await repository.listTaskResults(dataContext, operationId);
      const latestSource = await repository.readRetrySource(dataContext, operationId);
      if (latestSource.operation.stateVersion !== source.operation.stateVersion)
        throw new ApiHttpError(409, 'CONFLICT');
      const byTask = new Map(results.map((result) => [result.taskId, result]));
      const intents: RetryTaskIntent[] = plan.preflight.entries.flatMap((entry) => {
        const result = byTask.get(entry.taskId);
        const outcome = result?.refinement?.outcome ?? result?.outcome;
        if (
          !result ||
          entry.disposition !== 'eligible' ||
          entry.targetValues === null ||
          !(
            ['error', 'unconfirmed', 'conflict', 'not_processed', 'partially_applied'] as const
          ).some((candidate) => candidate === outcome)
        )
          return [];
        const fieldIds =
          outcome === 'partially_applied'
            ? (result.refinement?.failedFieldIds ?? result.failedFieldIds)
            : entry.changedFieldIds;
        const targetValues: Record<string, TaskChangeValue> = {};
        for (const fieldId of fieldIds) {
          const target = entry.targetValues[fieldId];
          if (!entry.changedFieldIds.includes(fieldId) || target === undefined)
            throw new ApiHttpError(409, 'CONFLICT');
          targetValues[fieldId] = target;
        }
        if (fieldIds.length === 0) throw new ApiHttpError(409, 'CONFLICT');
        return [{ taskId: entry.taskId, targetValues }];
      });
      if (intents.length === 0) throw new ApiHttpError(409, 'CONFLICT');
      const sourceKinds = new Map(plan.changes.map((change) => [change.fieldId, change.kind]));
      const targets = new Map<string, TaskChangeValue>();
      for (const intent of intents) {
        for (const [fieldId, value] of Object.entries(intent.targetValues)) {
          if (!targets.has(fieldId)) targets.set(fieldId, value);
        }
      }
      if (!fieldsWithinScope(access, [...targets.keys()])) throw new ApiHttpError(403, 'FORBIDDEN');
      const changes: BulkChangeCommand[] = [...targets]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([fieldId, value]) => {
          const kind = sourceKinds.get(fieldId);
          if (!kind) throw new ApiHttpError(409, 'CONFLICT');
          const candidate: unknown =
            value === null || (Array.isArray(value) && value.length === 0)
              ? { fieldId, kind, action: 'clear' }
              : Array.isArray(value)
                ? { fieldId, kind, action: 'replace', values: value }
                : { fieldId, kind, action: 'set', value };
          const parsed = bulkChangeCommandSchema.safeParse(candidate);
          if (!parsed.success) throw new ApiHttpError(409, 'CONFLICT');
          return parsed.data;
        });
      const renewed = await authorize(context);
      if (!sameAccess(access, renewed.access)) throw new ApiHttpError(409, 'CONFLICT');
      const saved = await repository.saveRetryDraft(renewed.dataContext, {
        sourceOperationId: operationId,
        sourceStateVersion: source.operation.stateVersion,
        selectedTaskIds: intents.map((intent) => intent.taskId),
        changes: asJson(changes),
        intents,
      });
      return context.json(bulkOperationDraftSchema.parse(saved));
    } catch (error) {
      if (error instanceof ApiHttpError) throw error;
      throwDataApiError(error);
    }
  });

  routes.get('/operations/:operationId/restore-source', async (context) => {
    const { access, dataContext } = await authorizePreflight(context);
    if (!access.permissions.includes('restore_operations'))
      throw new ApiHttpError(403, 'FORBIDDEN');
    const operationId = context.req.param('operationId');
    if (!operationIdSchema.safeParse(operationId).success) throw new ApiHttpError(404, 'NOT_FOUND');
    try {
      const source = await dependencies.createRepository(context.env)
        .readRestoreSource(dataContext, operationId);
      return context.json(restoreSourceAvailabilitySchema.parse({
        sourceOperationId: source.operationId,
        sourceStateVersion: source.stateVersion,
        tasks: source.tasks.filter((task) => fieldsWithinScope(access, task.appliedFieldIds))
          .map((task) => ({ taskId: task.taskId, title: task.title,
            taskUrl: task.taskUrl, appliedFieldIds: task.appliedFieldIds })),
      }));
    } catch (error) {
      throwDataApiError(error);
    }
  });

  routes.post('/operations/:operationId/restore-draft', async (context) => {
    const { principal, access, dataContext } = await authorizePreflight(context);
    if (!access.permissions.includes('restore_operations'))
      throw new ApiHttpError(403, 'FORBIDDEN');
    const operationId = context.req.param('operationId');
    if (!operationIdSchema.safeParse(operationId).success) throw new ApiHttpError(404, 'NOT_FOUND');
    const request = await parseJsonBody(context.req.raw, prepareRestoreDraftRequestSchema, 40_000);
    const repository = dependencies.createRepository(context.env);
    try {
      const source = await repository.readRestoreSource(dataContext, operationId);
      const byId = new Map(source.tasks.map((task) => [task.taskId, task]));
      const selected = request.selectedTaskIds.map((taskId) => byId.get(taskId));
      if (selected.some((task) => !task)) throw new ApiHttpError(409, 'CONFLICT');
      const tasks = selected.filter((task): task is NonNullable<typeof task> => !!task);
      if (!fieldsWithinScope(access, tasks.flatMap((task) => task.appliedFieldIds)))
        throw new ApiHttpError(403, 'FORBIDDEN');
      const capabilities = await loadCapabilities(createAdapter(context.env, principal.userId, principal.portalId));
      const catalog = createTaskChangeCatalog(capabilities, access.fieldScope);
      const kinds = new Map(catalog.fields.map((field) => [field.id, field.kind]));
      const fields = [...new Set(tasks.flatMap((task) => task.appliedFieldIds))].sort();
      if (fields.length > 64 || fields.some((fieldId) => !kinds.has(fieldId)))
        throw new ApiHttpError(409, 'CONFLICT');
      const intents: RestoreTaskIntent[] = [];
      for (const task of tasks) {
        if (task.payloadVersion !== 1 || !/^mock:[1-9][0-9]*$/.test(task.afterVersion))
          throw new ApiHttpError(409, 'CONFLICT');
        const previous = await decryptPreviousValues({
          keyBase64: context.env.OPERATION_PLAN_KEY_V1,
          portalId: principal.portalId, ownerId: source.ownerId,
          operationId, taskId: task.taskId, beforeVersion: task.beforeVersion,
          ciphertext: task.ciphertext, nonce: task.nonce, keyVersion: task.keyVersion,
        });
        const targetValues: Record<string, TaskChangeValue> = {};
        for (const fieldId of task.appliedFieldIds) {
          if (!Object.hasOwn(previous, fieldId)) throw new ApiHttpError(409, 'CONFLICT');
          targetValues[fieldId] = previous[fieldId]!;
        }
        intents.push({ taskId: task.taskId, fieldIds: task.appliedFieldIds,
          afterVersion: task.afterVersion, targetValues });
      }
      const latest = await repository.readRestoreSource(dataContext, operationId);
      const renewed = await authorize(context);
      if (latest.stateVersion !== source.stateVersion || !sameAccess(access, renewed.access))
        throw new ApiHttpError(409, 'CONFLICT');
      if (principal.isBitrixAdmin)
        await repository.ensurePrincipalIdentity(renewed.dataContext, principal.displayName);
      const draftId = crypto.randomUUID();
      const encryptedIntents = await encryptPrivateRestoreData({
        keyBase64: context.env.OPERATION_PLAN_KEY_V1,
        portalId: principal.portalId, ownerId: principal.userId,
        draftId, sourceOperationId: operationId,
        sourceStateVersion: source.stateVersion, revision: 1,
        purpose: 'intents', value: intents,
      });
      const changes = fields.map((fieldId) => bulkChangeCommandSchema.parse({
        fieldId, kind: kinds.get(fieldId), action: 'clear',
      }));
      const saved = await repository.saveRestoreDraft(renewed.dataContext, {
        draftId, sourceOperationId: operationId, sourceStateVersion: source.stateVersion,
        selectedTaskIds: tasks.map((task) => task.taskId), changes: asJson(changes),
        intents: intents.map(({ taskId, fieldIds, afterVersion }) =>
          ({ taskId, fieldIds, afterVersion })), encryptedIntents,
      });
      return context.json(bulkOperationDraftSchema.parse(saved));
    } catch (error) {
      if (error instanceof ApiHttpError) throw error;
      throwDataApiError(error);
    }
  });

  routes.get('/operations/current/progress', async (context) => {
    const { dataContext } = await authorizeProgress(context);
    try {
      const operation = await dependencies
        .createRepository(context.env)
        .getLatestOwnedOperationProgress(dataContext);
      return context.json(
        currentOperationProgressSchema.parse({
          progress: operation ? toProgress(operation) : null,
        }),
      );
    } catch (error) {
      throwDataApiError(error);
    }
  });

  routes.get('/operations/:operationId/progress', async (context) => {
    const { dataContext } = await authorizeProgress(context);
    const operationId = context.req.param('operationId');
    if (!operationIdSchema.safeParse(operationId).success) throw new ApiHttpError(404, 'NOT_FOUND');
    try {
      const operation = await dependencies
        .createRepository(context.env)
        .getOwnedOperationProgress(dataContext, operationId);
      return context.json(toProgress(operation));
    } catch (error) {
      throwDataApiError(error);
    }
  });

  routes.get('/operations/:operationId/results', async (context) => {
    const { dataContext } = await authorizeProgress(context);
    const operationId = context.req.param('operationId');
    if (!operationIdSchema.safeParse(operationId).success) throw new ApiHttpError(404, 'NOT_FOUND');
    const query = progressResultsQuerySchema.safeParse(context.req.query());
    if (!query.success) throw new ApiHttpError(400, 'INVALID_REQUEST');
    try {
      const page: OperationProgressResultsPage = await dependencies
        .createRepository(context.env)
        .listOwnedOperationProgressResults(dataContext, operationId, query.data);
      return context.json(operationProgressResultsPageSchema.parse(page));
    } catch (error) {
      throwDataApiError(error);
    }
  });

  routes.post('/operations/:operationId/cancel', async (context) => {
    await requireRateLimit(
      context.env.ACCESS_FANOUT_RATE_LIMITER,
      `client:${clientRateLimitKey(context.req.raw)}:operation-cancel`,
    );
    const { principal, access, dataContext } = await authorizeProgress(context);
    await requireRateLimit(
      context.env.ACCESS_FANOUT_RATE_LIMITER,
      `${principal.portalId}:${principal.userId}:operation-cancel`,
    );
    if (
      !access.permissions.includes('app_access') ||
      !access.permissions.includes('run_bulk_operations')
    ) {
      throw new ApiHttpError(403, 'FORBIDDEN');
    }
    const operationId = context.req.param('operationId');
    if (!operationIdSchema.safeParse(operationId).success) throw new ApiHttpError(404, 'NOT_FOUND');
    await parseJsonBody(context.req.raw, launchRetryEmptyRequestSchema, 128);
    try {
      const result = await dependencies
        .createRepository(context.env)
        .requestOperationCancellation(dataContext, {
          operationId,
          correlationId: context.get('correlationId'),
        });
      return context.json(toProgress(result.operation));
    } catch (error) {
      throwDataApiError(error);
    }
  });

  routes.post('/operations/:operationId/retry-launch', async (context) => {
    const { principal, access, dataContext } = await authorizePreflight(context);
    if (!access.permissions.includes('retry_operations')) throw new ApiHttpError(403, 'FORBIDDEN');
    const operationId = context.req.param('operationId');
    if (!operationIdSchema.safeParse(operationId).success) throw new ApiHttpError(404, 'NOT_FOUND');
    await parseJsonBody(context.req.raw, launchRetryEmptyRequestSchema, 128);
    const repository = dependencies.createRepository(context.env);
    try {
      const retried = await repository.retryConfirmedOperationLaunch(
        dataContext,
        operationId,
        context.get('correlationId'),
      );
      if (retried.operation.status === 'launching') {
        try {
          await dispatchOperationLaunch({
            env: context.env,
            repository,
            portalId: principal.portalId,
            operationId,
            correlationId: context.get('correlationId'),
          });
        } catch {
          // The persisted attempt remains inspectable and recoverable.
        }
      }
      return context.json(
        bulkOperationSchema.parse(
          await repository.readConfirmedOperationReceipt(dataContext, operationId),
        ),
      );
    } catch (error) {
      if (error instanceof ApiHttpError) throw error;
      throwDataApiError(error);
    }
  });

  return routes;
}
