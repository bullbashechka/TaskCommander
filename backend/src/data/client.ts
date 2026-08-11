import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { RuntimeEnvironment } from '../runtime/configuration';
import type { Database } from './database.types';
import { DataAccessError } from './errors';

export type SupabaseFetch = typeof fetch;

function getRequiredValue(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new DataAccessError('CONFIGURATION', false);
  }
  return normalized;
}

function isAllowedLocalSupabaseHost(env: RuntimeEnvironment, url: URL): boolean {
  if (env.APP_ENV !== 'local') {
    return true;
  }

  const configuredHosts = env.LOCAL_SUPABASE_ALLOWED_HOSTS?.split(',') ?? [];
  return configuredHosts.some((host) => host.trim().toLowerCase() === url.hostname.toLowerCase());
}

export function createServerSupabaseClient(
  env: RuntimeEnvironment,
  requestFetch: SupabaseFetch = fetch,
): SupabaseClient<Database> {
  const url = getRequiredValue(env.SUPABASE_URL);
  const serviceRoleKey = getRequiredValue(env.SUPABASE_SERVICE_ROLE_KEY);

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new DataAccessError('CONFIGURATION', false);
  }

  if (parsedUrl.protocol !== 'https:' || !isAllowedLocalSupabaseHost(env, parsedUrl)) {
    throw new DataAccessError('CONFIGURATION', false);
  }

  return createClient<Database>(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: {
      fetch: requestFetch,
      headers: { 'x-client-info': 'task-commander-worker' },
    },
  });
}
