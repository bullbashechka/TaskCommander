import type { RuntimeEnvironment } from '../runtime/configuration';
import { createServerSupabaseClient, type SupabaseFetch } from './client';
import { TaskCommanderRepositories } from './repositories';

export * from './access';
export * from './cursor';
export * from './errors';
export * from './repositories';

export function createTaskCommanderRepositories(
  env: RuntimeEnvironment,
  requestFetch?: SupabaseFetch,
): TaskCommanderRepositories {
  return new TaskCommanderRepositories(createServerSupabaseClient(env, requestFetch));
}
