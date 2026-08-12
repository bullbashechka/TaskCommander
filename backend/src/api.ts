import { Hono } from 'hono';
import { z } from 'zod';

import { createSessionRequestSchema, sessionResponseSchema } from '@task-commander/contracts';

import { clearSessionCookie, createSessionService } from './auth/session-service';
import { createApiErrorResponse, ApiHttpError } from './http/errors';
import { parseJsonBody } from './http/validation';
import { getRuntimeReadiness, type RuntimeEnvironment } from './runtime/configuration';
import { createRuntimeProbe } from './runtime/probe';

type ApiVariables = {
  correlationId: string;
};

export const api = new Hono<{ Bindings: RuntimeEnvironment; Variables: ApiVariables }>();

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
