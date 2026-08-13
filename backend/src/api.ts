import { Hono } from 'hono';
import { z } from 'zod';

import {
  createSessionRequestSchema,
  effectiveAccessResponseSchema,
  sessionResponseSchema,
} from '@task-commander/contracts';

import {
  clearSessionCookie,
  createSessionService,
  type VerifiedSessionPrincipal,
} from './auth/session-service';
import { createAccessManagementRoutes } from './access-management/routes';
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
import { parseJsonBody } from './http/validation';
import { getRuntimeReadiness, type RuntimeEnvironment } from './runtime/configuration';
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
          createSettingsReader(env).findEffectiveAccessSettings(input),
      }));
  const bitrixAdapterFactory = dependencies.createBitrixAdapter ?? createBitrixAdapter;

  api.use('/api/*', async (context, next) => {
    const correlationId = `TC-${crypto.randomUUID()}`;
    context.set('correlationId', correlationId);
    await next();
    context.header('x-correlation-id', correlationId);
  });

  api.use('/api/session', async (context, next) => {
    context.header('cache-control', 'no-store');
    if (context.req.method === 'GET') {
      context.header('vary', 'Cookie');
    }
    await next();
  });

  api.use('/api/access', async (context, next) => {
    context.header('cache-control', 'no-store');
    context.header('vary', 'Cookie');
    await next();
  });
  api.route(
    '/api/access-management',
    createAccessManagementRoutes({
      readPrincipal:
        dependencies.readPrincipal ?? ((env, cookie) => createSessionService(env).read(cookie)),
      readEffectiveAccess,
      createAdapter: bitrixAdapterFactory,
      createRepository:
        dependencies.createAccessManagementRepository ?? createAccessManagementRepository,
    }),
  );

  api.get('/api/health', (context) => context.json(getRuntimeReadiness(context.env)));

  api.post('/api/session', async (context) => {
    const request = await parseJsonBody(context.req.raw, createSessionRequestSchema, 4_352);
    const session = await createSessionService(context.env).create(request.launchContext);
    context.header('set-cookie', session.cookie);
    return context.json(sessionResponseSchema.parse({ principal: session.principal }), 201);
  });

  api.get('/api/session', async (context) => {
    const principal = await createSessionService(context.env).read(
      context.req.header('cookie') ?? null,
    );
    return context.json(sessionResponseSchema.parse({ principal }));
  });

  api.delete('/api/session', (context) => {
    context.header('set-cookie', clearSessionCookie());
    return context.body(null, 204);
  });

  api.get('/api/access', async (context) => {
    const principal = await createSessionService(context.env).read(
      context.req.header('cookie') ?? null,
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

  api.post('/api/_runtime/probe', async (context) => {
    if (context.env.APP_ENV !== 'local') {
      return context.notFound();
    }

    await parseJsonBody(context.req.raw, z.object({}).strict());

    const probe = createRuntimeProbe();
    const queue = (context.env as RuntimeEnvironment & Pick<Env, 'OPERATIONS_QUEUE'>)
      .OPERATIONS_QUEUE;
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
      return context.json(
        createApiErrorResponse(error.code, correlationId, error.fieldErrors),
        error.status,
      );
    }

    console.error(
      JSON.stringify({
        event: 'api_error',
        correlationId,
        errorName: error instanceof Error ? error.name : 'unknown',
      }),
    );
    return context.json(createApiErrorResponse('INTERNAL_ERROR', correlationId), 500);
  });

  return api;
}

export const api = createApi();
