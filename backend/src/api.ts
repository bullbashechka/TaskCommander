import { Hono } from 'hono';
import { type ApiErrorResponse } from '@task-commander/contracts';

import { getRuntimeReadiness, type RuntimeEnvironment } from './runtime/configuration';
import { createRuntimeProbe } from './runtime/probe';

export const api = new Hono<{ Bindings: RuntimeEnvironment }>();

api.get('/api/health', (context) => context.json(getRuntimeReadiness(context.env)));

api.post('/api/_runtime/probe', async (context) => {
  if (context.env.APP_ENV !== 'local') {
    return context.notFound();
  }

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
  const body: ApiErrorResponse = {
    error: {
      code: 'NOT_FOUND',
      message: 'Маршрут API не найден.',
    },
  };

  return context.json(body, 404);
});

api.onError((_error, context) => {
  console.error(JSON.stringify({ event: 'api_error' }));

  const body: ApiErrorResponse = {
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Внутренняя ошибка API.',
    },
  };

  return context.json(body, 500);
});
