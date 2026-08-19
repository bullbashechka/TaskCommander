import { isLivenessResponse, type LivenessResponse } from '@task-commander/contracts';

import { ru } from '@/locales/ru';

export async function fetchHealth(): Promise<LivenessResponse> {
  const response = await fetch('/api/health', {
    headers: { accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(ru.health.unavailable);
  }

  const payload: unknown = await response.json();
  if (!isLivenessResponse(payload)) {
    throw new Error(ru.health.unexpectedResponse);
  }

  return payload;
}
