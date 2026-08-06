import { isHealthResponse, type HealthResponse } from '@task-commander/contracts';

import { ru } from '@/locales/ru';

export async function fetchHealth(): Promise<HealthResponse> {
  const response = await fetch('/api/health', {
    headers: { accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(ru.health.unavailable);
  }

  const payload: unknown = await response.json();
  if (!isHealthResponse(payload)) {
    throw new Error(ru.health.unexpectedResponse);
  }

  return payload;
}
