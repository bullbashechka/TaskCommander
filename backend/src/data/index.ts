import type { RuntimeEnvironment } from '../runtime/configuration';
import { AuditWriter } from './audit';
import { createServerSupabaseClient, type SupabaseFetch } from './client';
import { TaskCommanderRepositories } from './repositories';

export * from './access';
export * from './audit';
export * from './cursor';
export * from './errors';
export * from './repositories';

export function createTaskCommanderRepositories(
  env: RuntimeEnvironment,
  requestFetch?: SupabaseFetch,
): TaskCommanderRepositories {
  return new TaskCommanderRepositories(createServerSupabaseClient(env, requestFetch));
}

export function createAuditWriter(
  env: RuntimeEnvironment,
  requestFetch?: SupabaseFetch,
): AuditWriter {
  return new AuditWriter(createServerSupabaseClient(env, requestFetch));
}
