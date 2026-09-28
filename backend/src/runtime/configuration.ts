import {
  type HealthResponse,
  type RuntimeReadinessState,
  type RuntimeSubsystemStatus,
} from '@task-commander/contracts';

import { isSupportedBitrixAdapterConfiguration } from '../integrations/bitrix/factory';
import {
  canonicalOrigin,
  hasValidConfiguredOrigins,
  parseAllowedServiceUrl,
} from './origin-policy';

/** Partial only for readiness checks and isolated tests; Worker entry points use generated exact types. */
export type RuntimeEnvironment = Partial<ApiEnvironment & ConsumerEnvironment>;

export class RuntimeConfigurationError extends Error {}

function encodeSigningSecret(secret: string | undefined): Uint8Array | null {
  if (secret === undefined) return null;

  const encoded = new TextEncoder().encode(secret);
  return encoded.byteLength >= 32 ? encoded : null;
}

export function hasStrongRuntimeSecret(secret: string | undefined): boolean {
  return encodeSigningSecret(secret) !== null;
}

export function hasValidOperationPlanKey(value: string | undefined): boolean {
  if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return false;
  try {
    const decoded = atob(value);
    return decoded.length === 32 && btoa(decoded) === value;
  } catch {
    return false;
  }
}

function haveEqualBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

export function hasLocalIdentityConfiguration(env: RuntimeEnvironment): boolean {
  const mockLaunchSecret = encodeSigningSecret(env.MOCK_LAUNCH_SIGNING_SECRET);
  const sessionSecret = encodeSigningSecret(env.SESSION_SIGNING_SECRET);
  return (
    isSupportedBitrixAdapterConfiguration(env) &&
    mockLaunchSecret !== null &&
    sessionSecret !== null &&
    !haveEqualBytes(mockLaunchSecret, sessionSecret)
  );
}

function hasBindingMethods(value: unknown, methods: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const binding = value as Record<string, unknown>;
  return methods.every((method) => typeof binding[method] === 'function');
}

export function hasLocalRuntimeConfiguration(env: RuntimeEnvironment): boolean {
  return isSupportedBitrixAdapterConfiguration(env);
}

export function getRequiredR2Binding(value: unknown): R2Bucket {
  if (!hasBindingMethods(value, ['put', 'get', 'delete'])) {
    throw new RuntimeConfigurationError('Local R2 binding is unavailable.');
  }

  return value as R2Bucket;
}

export function getRequiredQueueBinding(value: unknown): Queue {
  if (!hasBindingMethods(value, ['send'])) {
    throw new RuntimeConfigurationError('Queue binding is unavailable.');
  }

  return value as Queue;
}

function getSupabaseStatus(env: RuntimeEnvironment): RuntimeSubsystemStatus {
  const url = env.SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const allowedOrigins = env.SUPABASE_ALLOWED_ORIGINS?.trim();

  if (!url && !serviceRoleKey && !allowedOrigins) {
    return 'not_configured';
  }

  if (!url || !serviceRoleKey || !allowedOrigins) {
    return 'invalid_configuration';
  }

  return parseAllowedServiceUrl(url, allowedOrigins) ? 'ready' : 'invalid_configuration';
}

export function getRuntimeReadiness(env: RuntimeEnvironment): HealthResponse {
  const allowHttp = env.APP_ENV === 'local';
  const runtime =
    env.APP_ENV &&
    canonicalOrigin(env.APP_ORIGIN ?? '', allowHttp) &&
    canonicalOrigin(env.BITRIX_PORTAL_ORIGIN ?? '', allowHttp) &&
    hasValidConfiguredOrigins(env.BITRIX_FRAME_ANCESTORS, allowHttp) &&
    hasValidConfiguredOrigins(env.BITRIX_MEDIA_ALLOWED_ORIGINS, allowHttp) &&
    hasStrongRuntimeSecret(env.INTERNAL_READINESS_TOKEN) &&
    hasValidOperationPlanKey(env.OPERATION_PLAN_KEY_V1) &&
    (env.ENABLE_LOCAL_RUNTIME_PROBE !== 'true' ||
      hasStrongRuntimeSecret(env.LOCAL_RUNTIME_PROBE_TOKEN)) &&
    hasBindingMethods(env.SESSION_RATE_LIMITER, ['limit']) &&
    hasBindingMethods(env.PROBE_RATE_LIMITER, ['limit']) &&
    hasBindingMethods(env.ACCESS_FANOUT_RATE_LIMITER, ['limit'])
      ? 'ready'
      : 'invalid_configuration';
  const cron = hasLocalRuntimeConfiguration(env) ? 'ready' : 'invalid_configuration';
  const bitrix = hasLocalIdentityConfiguration(env) ? 'ready' : 'invalid_configuration';
  const subsystems = {
    runtime,
    queue:
      hasBindingMethods(env.OPERATIONS_QUEUE, ['send']) &&
      hasBindingMethods(env.ACCESS_COMMANDS_QUEUE, ['send']) &&
      Boolean(env.OPERATIONS_QUEUE_NAME?.trim()) &&
      Boolean(env.ACCESS_COMMANDS_QUEUE_NAME?.trim()) &&
      env.OPERATIONS_QUEUE_NAME !== env.ACCESS_COMMANDS_QUEUE_NAME
        ? 'ready'
        : 'invalid_configuration',
    r2: hasBindingMethods(env.REPORTS_BUCKET, ['put', 'get', 'delete'])
      ? 'ready'
      : 'invalid_configuration',
    cron,
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
