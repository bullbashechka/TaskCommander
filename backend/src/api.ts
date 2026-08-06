import { Hono } from 'hono';
import { healthResponse, type ApiErrorResponse } from '@task-commander/contracts';

export const api = new Hono();

api.get('/api/health', (context) => context.json(healthResponse));

api.notFound((context) => {
  const body: ApiErrorResponse = {
    error: {
      code: 'NOT_FOUND',
      message: 'Маршрут API не найден.',
    },
  };

  return context.json(body, 404);
});

api.onError((error, context) => {
  console.error(JSON.stringify({ event: 'api_error', message: error.message }));

  const body: ApiErrorResponse = {
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Внутренняя ошибка API.',
    },
  };

  return context.json(body, 500);
});
