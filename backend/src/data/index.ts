import type { RuntimeEnvironment } from '../runtime/configuration';
import { AccessManagementRepository } from './access-management-repository';
import { AuditWriter } from './audit';
import { createServerSupabaseClient, type SupabaseFetch } from './client';
import { TaskCommanderRepositories } from './repositories';
import { configuredOrigins } from '../runtime/origin-policy';

export * from './access';
export * from './access-management-repository';
export * from './audit';
export * from './cursor';
export * from './errors';
export * from './repositories';

export function createTaskCommanderRepositories(
  env: RuntimeEnvironment,
  requestFetch?: SupabaseFetch,
): TaskCommanderRepositories {
  return new TaskCommanderRepositories(
    createServerSupabaseClient(env, requestFetch),
    configuredOrigins(env.BITRIX_PORTAL_ORIGIN, env.APP_ENV === 'local'),
  );
}

export function createAuditWriter(
  env: RuntimeEnvironment,
  requestFetch?: SupabaseFetch,
): AuditWriter {
  return new AuditWriter(createServerSupabaseClient(env, requestFetch));
}

export function createAccessManagementRepository(
  env: RuntimeEnvironment,
  requestFetch?: SupabaseFetch,
): AccessManagementRepository {
  return new AccessManagementRepository(createServerSupabaseClient(env, requestFetch));
}
