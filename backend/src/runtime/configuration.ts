import {
  type HealthResponse,
  type RuntimeReadinessState,
  type RuntimeSubsystemStatus,
} from '@task-commander/contracts';

export interface RuntimeEnvironment {
  APP_ENV?: string;
  BITRIX_ADAPTER?: string;
  LOCAL_SUPABASE_ALLOWED_HOSTS?: string;
  OPERATIONS_QUEUE?: unknown;
  REPORTS_BUCKET?: unknown;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_URL?: string;
}

export class RuntimeConfigurationError extends Error {}

function hasBindingMethods(value: unknown, methods: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const binding = value as Record<string, unknown>;
  return methods.every((method) => typeof binding[method] === 'function');
}

export function hasLocalRuntimeConfiguration(env: RuntimeEnvironment): boolean {
  return env.APP_ENV === 'local' && env.BITRIX_ADAPTER === 'mock';
}

export function getRequiredR2Binding(value: unknown): R2Bucket {
  if (!hasBindingMethods(value, ['put', 'get', 'delete'])) {
    throw new RuntimeConfigurationError('Local R2 binding is unavailable.');
  }

  return value as R2Bucket;
}

function getSupabaseStatus(env: RuntimeEnvironment): RuntimeSubsystemStatus {
  const url = env.SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const allowedHosts = env.LOCAL_SUPABASE_ALLOWED_HOSTS?.trim();

  if (!url && !serviceRoleKey && !allowedHosts) {
    return 'not_configured';
  }

  if (!url || !serviceRoleKey || !allowedHosts) {
    return 'invalid_configuration';
  }

  try {
    const host = new URL(url).hostname.toLowerCase();
    const normalizedAllowedHosts = allowedHosts
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);

    return normalizedAllowedHosts.includes(host) ? 'ready' : 'invalid_configuration';
  } catch {
    return 'invalid_configuration';
  }
}

export function getRuntimeReadiness(env: RuntimeEnvironment): HealthResponse {
  const runtime = env.APP_ENV === 'local' ? 'ready' : 'invalid_configuration';
  const bitrix = env.BITRIX_ADAPTER === 'mock' ? 'ready' : 'invalid_configuration';
  const subsystems = {
    runtime,
    queue: hasBindingMethods(env.OPERATIONS_QUEUE, ['send']) ? 'ready' : 'invalid_configuration',
    r2: hasBindingMethods(env.REPORTS_BUCKET, ['put', 'get', 'delete']) ? 'ready' : 'invalid_configuration',
    cron: runtime === 'ready' ? 'ready' : 'invalid_configuration',
    supabase: getSupabaseStatus(env),
    bitrix,
  } satisfies HealthResponse['subsystems'];
  const readiness: RuntimeReadinessState = Object.values(subsystems).every(
    (status) => status === 'ready',
  )
    ? 'ready'
    : 'degraded';

  return {
    status: 'ok',
    service: 'task-commander-api',
    readiness,
    subsystems,
  };
}
