import {
  type HealthResponse,
  type RuntimeReadinessState,
  type RuntimeSubsystemStatus,
} from '@task-commander/contracts';

import { isSupportedBitrixAdapterConfiguration } from '../integrations/bitrix/factory';

export interface RuntimeEnvironment {
  APP_ENV?: string;
  BITRIX_ADAPTER?: string;
  MOCK_LAUNCH_SIGNING_SECRET?: string;
  LOCAL_SUPABASE_ALLOWED_HOSTS?: string;
  OPERATIONS_QUEUE?: unknown;
  ACCESS_COMMANDS_QUEUE?: unknown;
  REPORTS_BUCKET?: unknown;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_URL?: string;
  SESSION_SIGNING_SECRET?: string;
}

export class RuntimeConfigurationError extends Error {}

function encodeSigningSecret(secret: string | undefined): Uint8Array | null {
  if (secret === undefined) return null;

  const encoded = new TextEncoder().encode(secret);
  return encoded.byteLength >= 32 ? encoded : null;
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
  const cron = hasLocalRuntimeConfiguration(env) ? 'ready' : 'invalid_configuration';
  const bitrix = hasLocalIdentityConfiguration(env) ? 'ready' : 'invalid_configuration';
  const subsystems = {
    runtime,
    queue:
      hasBindingMethods(env.OPERATIONS_QUEUE, ['send']) &&
      hasBindingMethods(env.ACCESS_COMMANDS_QUEUE, ['send'])
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
