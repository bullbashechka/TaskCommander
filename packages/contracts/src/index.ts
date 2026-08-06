export const healthResponse = {
  status: 'ok',
  service: 'task-commander-api',
} as const;

export type HealthResponse = typeof healthResponse;

export type ApiErrorCode = 'INTERNAL_ERROR' | 'NOT_FOUND';

export interface ApiErrorResponse {
  error: {
    code: ApiErrorCode;
    message: string;
  };
}

export function isHealthResponse(value: unknown): value is HealthResponse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return candidate.status === healthResponse.status && candidate.service === healthResponse.service;
}
