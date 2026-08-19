import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { RuntimeEnvironment } from '../runtime/configuration';
import { parseAllowedServiceUrl } from '../runtime/origin-policy';
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

export function createServerSupabaseClient(
  env: RuntimeEnvironment,
  requestFetch: SupabaseFetch = fetch,
): SupabaseClient<Database> {
  const url = getRequiredValue(env.SUPABASE_URL);
  const serviceRoleKey = getRequiredValue(env.SUPABASE_SERVICE_ROLE_KEY);

  const parsedUrl = parseAllowedServiceUrl(url, env.SUPABASE_ALLOWED_ORIGINS);
  if (!parsedUrl) {
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
