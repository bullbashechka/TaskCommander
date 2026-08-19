import {
  auditWriteEventSchema,
  parseAuditEventForRead,
  type AuditEvent,
  type AuditWriteEvent,
} from '@task-commander/contracts';
import { type SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import type { Database, Json } from './database.types';
import { toDataAccessError } from './errors';

type Client = SupabaseClient<Database>;

const auditAppendResponseSchema = z
  .object({
    inserted: z.boolean(),
    event: z.record(z.unknown()),
  })
  .strict();

const forbiddenKeyNames = new Set([
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'cookie',
  'secret',
  'webhook',
  'previousvalues',
  'protectedpreviousvalues',
  'beforevalues',
  'ciphertext',
  'nonce',
  'apikey',
  'servicekey',
  'servicerolekey',
  'jwt',
]);

function normalizeKey(value: string): string {
  return value.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function redactString(value: string): string {
  return value
    .replace(/bearer\s+[a-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/basic\s+[a-z0-9+/=]+/gi, 'Basic [REDACTED]')
    .replace(/(?:bearer|basic)%20[a-z0-9._~%+/=-]+/gi, '[REDACTED_ENCODED_AUTH]')
    .replace(/\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/g, '[REDACTED_JWT]')
    .replace(
      /\beyJ[a-zA-Z0-9_-]{8,}%2[eE][a-zA-Z0-9_-]{8,}%2[eE][a-zA-Z0-9_-]{8,}\b/g,
      '[REDACTED_JWT]',
    )
    .replace(/\b(?:sbp|sb_secret|service_role)_[a-zA-Z0-9_-]{16,}\b/gi, '[REDACTED_KEY]')
    .replace(/https?%3[aA]%2[fF]%2[fF][^\s%]+%3[aA][^\s%]+%40/gi, '[REDACTED_CREDENTIAL_URL]')
    .replace(/https?:\/\/[^\s]+\/rest\/[^\s]+/gi, '[REDACTED_BITRIX_URL]')
    .replace(
      /([?&](?:access_token|refresh_token|token|auth|api[_-]?key|key)=)[^&\s]+/gi,
      '$1[REDACTED]',
    )
    .replace(
      /((?:access_token|refresh_token|token|auth|api[_-]?key|key)%3[dD])[^&\s]+/gi,
      '$1[REDACTED]',
    );
}

export function redactSensitiveAuditData(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactSensitiveAuditData);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (forbiddenKeyNames.has(normalizeKey(key))) {
      continue;
    }
    result[key] = redactSensitiveAuditData(nestedValue);
  }
  return result;
}

function toDatabaseJson(value: unknown): Json {
  return value as Json;
}

export interface AppendedAuditEvent {
  inserted: boolean;
  event: AuditEvent;
}

export interface AuditAppendRequest {
  portalId: string;
  event: AuditWriteEvent;
}

const auditAppendRequestSchema = z
  .object({
    portalId: z.string().trim().min(1).max(128),
    event: auditWriteEventSchema,
  })
  .strict();

export function createAuditAppendRequest(value: AuditAppendRequest): AuditAppendRequest {
  return auditAppendRequestSchema.parse(redactSensitiveAuditData(value));
}

export class AuditWriter {
  public constructor(private readonly client: Client) {}

  public async append(value: AuditAppendRequest): Promise<AppendedAuditEvent> {
    const request = createAuditAppendRequest(value);
    const input = request.event;
    const actor = input.actor;
    const { data, error } = await this.client.rpc('append_audit_event', {
      p_portal_id: request.portalId,
      p_occurred_at: input.occurredAt,
      p_action: input.action,
      p_actor_type: actor.type,
      p_actor_id: actor.type === 'user' ? actor.id : null,
      p_actor_display_name: actor.displayName,
      p_actor_source: actor.type === 'system' ? actor.source : null,
      p_subject_type: input.subject.type,
      p_subject_id: input.subject.id,
      p_subject_display_name: input.subject.displayName,
      p_related_objects: toDatabaseJson(input.relatedObjects),
      p_outcome: input.outcome,
      p_correlation_id: input.correlationId,
      p_deduplication_scope: input.deduplicationScope,
      p_event_slot: input.eventSlot,
      p_details: toDatabaseJson(input.details),
    });

    if (error) {
      throw toDataAccessError(error);
    }

    const parsed = auditAppendResponseSchema.parse(data);
    return {
      inserted: parsed.inserted,
      event: parseAuditEventForRead(parsed.event),
    };
  }
}
