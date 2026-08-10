import { Hono } from 'hono';
import { z } from 'zod';

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

api.get('/api/health', (context) => context.json(getRuntimeReadiness(context.env)));

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
