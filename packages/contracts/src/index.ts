export const runtimeSubsystems = ['runtime', 'queue', 'r2', 'cron', 'supabase', 'bitrix'] as const;

export type RuntimeSubsystem = (typeof runtimeSubsystems)[number];

export const runtimeReadinessStates = ['ready', 'degraded'] as const;

export type RuntimeReadinessState = (typeof runtimeReadinessStates)[number];

export const runtimeSubsystemStatuses = [
  'ready',
  'not_configured',
  'invalid_configuration',
] as const;

export type RuntimeSubsystemStatus = (typeof runtimeSubsystemStatuses)[number];

export interface HealthResponse {
  status: 'ok';
  service: 'task-commander-api';
  readiness: RuntimeReadinessState;
  subsystems: Record<RuntimeSubsystem, RuntimeSubsystemStatus>;
}

export const healthResponse: HealthResponse = {
  status: 'ok',
  service: 'task-commander-api',
  readiness: 'degraded',
  subsystems: {
    runtime: 'ready',
    queue: 'ready',
    r2: 'ready',
    cron: 'ready',
    supabase: 'not_configured',
    bitrix: 'ready',
  },
};

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
  if (
    candidate.status !== healthResponse.status ||
    candidate.service !== healthResponse.service ||
    !runtimeReadinessStates.includes(candidate.readiness as RuntimeReadinessState) ||
    typeof candidate.subsystems !== 'object' ||
    candidate.subsystems === null
  ) {
    return false;
  }

  const subsystems = candidate.subsystems as Record<string, unknown>;
  return runtimeSubsystems.every((subsystem) =>
    runtimeSubsystemStatuses.includes(subsystems[subsystem] as RuntimeSubsystemStatus),
  );
}
