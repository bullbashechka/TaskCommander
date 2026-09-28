import { z } from 'zod';

import { DataAccessError } from './errors';

const cursorSchema = z
  .object({
    version: z.literal(1),
    entity: z.enum(['operation-history', 'audit-events', 'operation-progress-results']),
    scope: z.string().min(1).max(512),
    asOf: z.string().datetime({ offset: true }),
    timestamp: z.string().datetime({ offset: true }),
    id: z.string().uuid(),
  })
  .strict();

export type PageEntity = z.infer<typeof cursorSchema>['entity'];

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface PageRequest {
  cursor?: string;
  limit?: number;
}

export interface ResolvedPageRequest {
  asOf: string;
  before: { timestamp: string; id: string } | null;
  limit: number;
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decodeBase64Url(value: string): string {
  const padded = `${value.replaceAll('-', '+').replaceAll('_', '/')}${'='.repeat(
    (4 - (value.length % 4)) % 4,
  )}`;
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function resolvePageRequest(
  request: PageRequest,
  entity: PageEntity,
  scope: string,
): ResolvedPageRequest {
  const limit = request.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new DataAccessError('CONFLICT', false);
  }

  if (!request.cursor) {
    return { asOf: new Date().toISOString(), before: null, limit };
  }

  try {
    const parsed = cursorSchema.parse(JSON.parse(decodeBase64Url(request.cursor)) as unknown);
    if (parsed.entity !== entity || parsed.scope !== scope) {
      throw new DataAccessError('CONFLICT', false);
    }

    return {
      asOf: parsed.asOf,
      before: { timestamp: parsed.timestamp, id: parsed.id },
      limit,
    };
  } catch (error) {
    if (error instanceof DataAccessError) {
      throw error;
    }
    throw new DataAccessError('CONFLICT', false);
  }
}

export function createNextCursor(
  entity: PageEntity,
  scope: string,
  asOf: string,
  timestamp: string,
  id: string,
): string {
  return encodeBase64Url(JSON.stringify({ version: 1, entity, scope, asOf, timestamp, id }));
}
