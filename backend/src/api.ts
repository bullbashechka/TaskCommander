import { Hono } from 'hono';
import { z } from 'zod';

import {
  createSessionRequestSchema,
  effectiveAccessResponseSchema,
  sessionResponseSchema,
  taskSearchApiRequestSchema,
  taskSearchApiResponseSchema,
  taskSelectAllApiRequestSchema,
  taskSelectAllApiResponseSchema,
} from '@task-commander/contracts';

import {
  clearSessionCookie,
  createSessionService,
  type VerifiedSessionPrincipal,
} from './auth/session-service';
import {
  createLocalDevSession,
  createLocalDevSessionRequestSchema,
} from './auth/local-dev-session';
import { createAccessManagementRoutes } from './access-management/routes';
import {
  CurrentIdentityError,
  verifyCurrentSessionPrincipal,
} from './access-management/automatic-revocation';
import {
  createAccessManagementRepository,
  createTaskCommanderRepositories,
  type AccessManagementRepository,
} from './data';
import {
  EffectiveAccessError,
  getEffectiveAccessResponse,
  requirePermission,
  resolveEffectiveAccess,
  type EffectiveAccess,
  type EffectiveAccessSettingsReader,
} from './data/access';
import { createApiErrorResponse, ApiHttpError } from './http/errors';
import type { BitrixAdapter } from './integrations/bitrix/contract';
import { createBitrixAdapter } from './integrations/bitrix/factory';
import { taskSearchPageSchema, taskSelectAllResultSchema } from './integrations/bitrix/schemas';
import {
  createTaskFilterCatalog,
  InvalidTaskSearchDefinitionError,
  requireValidTaskSearchDefinition,
} from './task-filters/catalog';
import { toTaskFilterBitrixApiError } from './task-filters/errors';
import { createTaskFilterRoutes, type TaskFilterRouteDependencies } from './task-filters/routes';
import { createTaskChangeRoutes, type TaskChangeRouteDependencies } from './task-changes/routes';
import { parseJsonBody } from './http/validation';
import {
  applySecurityHeaders,
  clientRateLimitKey,
  getApplicationOrigin,
  haveEqualSecretValues,
  isLoopbackRequest,
  requireRateLimit,
  requireSameOriginJsonRequest,
} from './http/security';
import {
  getRequiredQueueBinding,
  getRuntimeReadiness,
  hasStrongRuntimeSecret,
  type RuntimeEnvironment,
} from './runtime/configuration';
import { createRuntimeProbe } from './runtime/probe';

type ApiVariables = {
  correlationId: string;
};

export interface ApiDependencies {
  readonly readPrincipal?: (
    env: RuntimeEnvironment,
    cookie: string | null,
  ) => Promise<VerifiedSessionPrincipal>;
  readonly readEffectiveAccess?: (
    env: RuntimeEnvironment,
    principal: VerifiedSessionPrincipal,
  ) => Promise<EffectiveAccess>;
  readonly createSettingsReader?: (env: RuntimeEnvironment) => EffectiveAccessSettingsReader;
  readonly createBitrixAdapter?: (
    env: RuntimeEnvironment,
    input: { currentUserId: string },
  ) => BitrixAdapter;
  readonly createAccessManagementRepository?: (
    env: RuntimeEnvironment,
  ) => AccessManagementRepository;
  readonly createTaskFilterRepository?: TaskFilterRouteDependencies['createRepository'];
  readonly createTaskChangeRepository?: TaskChangeRouteDependencies['createRepository'];
}

function toApiHttpError(error: EffectiveAccessError): ApiHttpError {
  switch (error.kind) {
    case 'forbidden':
      return new ApiHttpError(403, 'FORBIDDEN');
    case 'not_found':
      return new ApiHttpError(404, 'NOT_FOUND');
    case 'upstream_unavailable':
      return new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
  }
}

function toCurrentIdentityApiError(error: CurrentIdentityError): ApiHttpError {
  switch (error.kind) {
    case 'revoked':
      return new ApiHttpError(403, 'ACCESS_REVOKED');
    case 'unauthenticated':
      return new ApiHttpError(401, 'UNAUTHENTICATED');
    case 'unavailable':
      return new ApiHttpError(503, 'ACCESS_VERIFICATION_UNAVAILABLE');
  }
}

export function createApi(dependencies: ApiDependencies = {}) {
  const api = new Hono<{ Bindings: RuntimeEnvironment; Variables: ApiVariables }>();
  const createSettingsReader =
    dependencies.createSettingsReader ??
    ((env: RuntimeEnvironment) => createTaskCommanderRepositories(env));
  const readEffectiveAccess =
    dependencies.readEffectiveAccess ??
    ((env: RuntimeEnvironment, principal: VerifiedSessionPrincipal) =>
      resolveEffectiveAccess(principal, {
        findEffectiveAccessSettings: async (input) =>
          await createSettingsReader(env).findEffectiveAccessSettings(input),
      }));
  const bitrixAdapterFactory = dependencies.createBitrixAdapter ?? createBitrixAdapter;
  const readSignedPrincipal =
    dependencies.readPrincipal ??
    ((env: RuntimeEnvironment, cookie: string | null) => createSessionService(env).read(cookie));
  const readCurrentPrincipal = async (
    env: RuntimeEnvironment,
    cookie: string | null,
    correlationId: string,
  ): Promise<VerifiedSessionPrincipal> => {
    const principal = await readSignedPrincipal(env, cookie);
    try {
      return await verifyCurrentSessionPrincipal({
        env,
        principal,
        adapter: bitrixAdapterFactory(env, { currentUserId: principal.userId }),
        createRepository: () =>
          dependencies.createAccessManagementRepository?.(env) ??
          createAccessManagementRepository(env),
        correlationId,
      });
    } catch (error) {
      if (error instanceof CurrentIdentityError) throw toCurrentIdentityApiError(error);
      throw error;
    }
  };

  api.use('/api/*', async (context, next) => {
    const correlationId = `TC-${crypto.randomUUID()}`;
    context.set('correlationId', correlationId);
    const path = new URL(context.req.url).pathname;
    if (path !== '/api/_dev/session' && path !== '/api/_runtime/probe') {
      requireSameOriginJsonRequest(context.env, context.req.raw);
    }
    await next();
    context.header('x-correlation-id', correlationId);
    const response = context.res;
    context.res = applySecurityHeaders(response, context.env);
  });

  api.use('/api/session', async (context, next) => {
    context.header('cache-control', 'no-store');
    if (context.req.method === 'GET') {
      context.header('vary', 'Cookie');
    }
    await next();
  });

  api.use('/api/_dev/session', async (context, next) => {
    context.header('cache-control', 'no-store');
    await next();
  });

  api.use('/api/access', async (context, next) => {
    context.header('cache-control', 'no-store');
    context.header('vary', 'Cookie');
    await next();
  });

  api.use('/api/tasks/*', async (context, next) => {
    context.header('cache-control', 'no-store');
    context.header('vary', 'Cookie');
    await next();
  });
  api.route(
    '/api/access-management',
    createAccessManagementRoutes({
      readPrincipal: (env, cookie) =>
        readCurrentPrincipal(env, cookie, `TC-${crypto.randomUUID()}`),
      readEffectiveAccess,
      createAdapter: bitrixAdapterFactory,
      createRepository:
        dependencies.createAccessManagementRepository ?? createAccessManagementRepository,
    }),
  );
  api.route(
    '/api/tasks',
    createTaskFilterRoutes({
      readPrincipal: (env, cookie, correlationId) =>
        readCurrentPrincipal(env, cookie, correlationId),
      readEffectiveAccess,
      createAdapter: bitrixAdapterFactory,
      createRepository: dependencies.createTaskFilterRepository ?? createTaskCommanderRepositories,
    }),
  );
  api.route(
    '/api/tasks',
    createTaskChangeRoutes({
      readPrincipal: (env, cookie, correlationId) =>
        readCurrentPrincipal(env, cookie, correlationId),
      readEffectiveAccess,
      createAdapter: bitrixAdapterFactory,
      createRepository: dependencies.createTaskChangeRepository ?? createTaskCommanderRepositories,
    }),
  );

  api.get('/api/health', (context) => context.json({ status: 'ok' }));

  api.get('/api/_internal/readiness', (context) => {
    context.header('cache-control', 'no-store');
    const token = context.env.INTERNAL_READINESS_TOKEN;
    if (
      !hasStrongRuntimeSecret(token) ||
      !haveEqualSecretValues(token, context.req.header('x-task-commander-readiness-token') ?? null)
    ) {
      return context.notFound();
    }
    const readiness = getRuntimeReadiness(context.env);
    return context.json(readiness, readiness.readiness === 'ready' ? 200 : 503);
  });

  api.post('/api/session', async (context) => {
    await requireRateLimit(
      context.env.SESSION_RATE_LIMITER,
      `${getApplicationOrigin(context.env) ?? 'invalid'}:${clientRateLimitKey(context.req.raw)}:session`,
    );
    const request = await parseJsonBody(context.req.raw, createSessionRequestSchema, 4_352);
    const session = await createSessionService(context.env).create(request.launchContext);
    context.header('set-cookie', session.cookie);
    return context.json(sessionResponseSchema.parse({ principal: session.principal }), 201);
  });

  api.get('/api/session', async (context) => {
    const principal = await readCurrentPrincipal(
      context.env,
      context.req.header('cookie') ?? null,
      context.get('correlationId'),
    );
    return context.json(sessionResponseSchema.parse({ principal }));
  });

  api.delete('/api/session', (context) => {
    context.header('set-cookie', clearSessionCookie());
    return context.body(null, 204);
  });

  api.post('/api/_dev/session', async (context) => {
    if (context.env.APP_ENV !== 'local' || !isLoopbackRequest(context.req.raw)) {
      return context.notFound();
    }
    requireSameOriginJsonRequest(context.env, context.req.raw);

    const request = await parseJsonBody(context.req.raw, createLocalDevSessionRequestSchema, 64);
    const session = await createLocalDevSession(context.env, request.userId);
    context.header('set-cookie', session.cookie);
    return context.body(null, 204);
  });

  api.get('/api/access', async (context) => {
    const principal = await readCurrentPrincipal(
      context.env,
      context.req.header('cookie') ?? null,
      context.get('correlationId'),
    );
    let access: EffectiveAccess;
    try {
      access = await readEffectiveAccess(context.env, principal);
      requirePermission(access, 'app_access');
    } catch (error) {
      if (error instanceof EffectiveAccessError) {
        throw toApiHttpError(error);
      }
      throw error;
    }
    return context.json(effectiveAccessResponseSchema.parse(getEffectiveAccessResponse(access)));
  });

  api.post('/api/tasks/search', async (context) => {
    const principal = await readCurrentPrincipal(
      context.env,
      context.req.header('cookie') ?? null,
      context.get('correlationId'),
    );

    try {
      const access = await readEffectiveAccess(context.env, principal);
      requirePermission(access, 'app_access');
    } catch (error) {
      if (error instanceof EffectiveAccessError) throw toApiHttpError(error);
      throw error;
    }

    const request = await parseJsonBody(context.req.raw, taskSearchApiRequestSchema);

    let rawPage: unknown;
    try {
      const adapter = bitrixAdapterFactory(context.env, { currentUserId: principal.userId });
      const capabilities = await adapter.tasks.getFieldCapabilities();
      if (!capabilities.ok) throw toTaskFilterBitrixApiError(capabilities.failure);
      const catalog = createTaskFilterCatalog(capabilities.value);
      requireValidTaskSearchDefinition(request, catalog);
      const result = await adapter.tasks.search(request);
      if (!result.ok) throw toTaskFilterBitrixApiError(result.failure);
      rawPage = result.value;
    } catch (error) {
      if (error instanceof ApiHttpError) throw error;
      if (error instanceof InvalidTaskSearchDefinitionError) {
        throw new ApiHttpError(400, 'INVALID_REQUEST');
      }
      throw new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
    }

    const page = taskSearchPageSchema.safeParse(rawPage);
    if (!page.success) throw new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');

    const pageStart = (request.page - 1) * request.pageSize;
    const expectedItemCount = Math.min(
      request.pageSize,
      Math.max(0, page.data.total - pageStart),
    );
    const expectedHasNextPage = pageStart + expectedItemCount < page.data.total;
    const invalidPagination =
      page.data.items.length !== expectedItemCount ||
      page.data.hasNextPage !== expectedHasNextPage;
    if (invalidPagination) throw new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');

    return context.json(
      taskSearchApiResponseSchema.parse({
        ...page.data,
        page: request.page,
        pageSize: request.pageSize,
      }),
    );
  });

  api.post('/api/tasks/select-all', async (context) => {
    const principal = await readCurrentPrincipal(
      context.env,
      context.req.header('cookie') ?? null,
      context.get('correlationId'),
    );

    try {
      const access = await readEffectiveAccess(context.env, principal);
      requirePermission(access, 'app_access');
    } catch (error) {
      if (error instanceof EffectiveAccessError) throw toApiHttpError(error);
      throw error;
    }

    const request = await parseJsonBody(context.req.raw, taskSelectAllApiRequestSchema);

    let rawResolution: unknown;
    try {
      const adapter = bitrixAdapterFactory(context.env, { currentUserId: principal.userId });
      const capabilities = await adapter.tasks.getFieldCapabilities();
      if (!capabilities.ok) throw toTaskFilterBitrixApiError(capabilities.failure);
      const catalog = createTaskFilterCatalog(capabilities.value);
      requireValidTaskSearchDefinition(request, catalog);
      const result = await adapter.tasks.selectAll(request);
      if (!result.ok) throw toTaskFilterBitrixApiError(result.failure);
      rawResolution = result.value;
    } catch (error) {
      if (error instanceof ApiHttpError) throw error;
      if (error instanceof InvalidTaskSearchDefinitionError) {
        throw new ApiHttpError(400, 'INVALID_REQUEST');
      }
      throw new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
    }

    const resolution = taskSelectAllResultSchema.safeParse(rawResolution);
    if (!resolution.success) throw new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
    return context.json(taskSelectAllApiResponseSchema.parse(resolution.data));
  });

  api.post('/api/_runtime/probe', async (context) => {
    if (
      context.env.APP_ENV !== 'local' ||
      context.env.ENABLE_LOCAL_RUNTIME_PROBE !== 'true' ||
      !hasStrongRuntimeSecret(context.env.LOCAL_RUNTIME_PROBE_TOKEN) ||
      !isLoopbackRequest(context.req.raw) ||
      !haveEqualSecretValues(
        context.env.LOCAL_RUNTIME_PROBE_TOKEN,
        context.req.header('x-task-commander-probe-token') ?? null,
      )
    ) {
      return context.notFound();
    }
    requireSameOriginJsonRequest(context.env, context.req.raw);

    await requireRateLimit(
      context.env.PROBE_RATE_LIMITER,
      `${getApplicationOrigin(context.env) ?? 'invalid'}:runtime-probe`,
    );

    await parseJsonBody(context.req.raw, z.object({}).strict());

    const probe = createRuntimeProbe();
    const queue = getRequiredQueueBinding(context.env.OPERATIONS_QUEUE);
    await queue.send(probe);

    return context.json(
      {
        messageId: probe.messageId,
        artifactKey: probe.payload.artifactKey,
      },
      202,
    );
  });

  api.notFound((context) => {
    const body = createApiErrorResponse('NOT_FOUND', context.get('correlationId'));
    return context.json(body, 404);
  });

  api.onError((error, context) => {
    const correlationId = context.get('correlationId');

    if (error instanceof ApiHttpError) {
      const response = context.json(
        createApiErrorResponse(error.code, correlationId, error.fieldErrors),
        error.status,
      );
      if (error.status === 429) response.headers.set('retry-after', '60');
      return applySecurityHeaders(response, context.env);
    }

    console.error(
      JSON.stringify({
        event: 'api_error',
        correlationId,
        errorName: error instanceof Error ? error.name : 'unknown',
      }),
    );
    return applySecurityHeaders(
      context.json(createApiErrorResponse('INTERNAL_ERROR', correlationId), 500),
      context.env,
    );
  });

  return api;
}

export const api = createApi();
