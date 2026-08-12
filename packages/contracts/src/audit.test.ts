import { describe, expect, it } from 'vitest';

import {
  auditActionSchema,
  auditEventSchema,
  auditWriteEventSchema,
  parseAuditEventForRead,
} from './audit';

const correlationId = 'TC-123e4567-e89b-42d3-a456-426614174000';
const timestamp = '2026-08-11T09:00:00.000Z';

describe('audit contracts', () => {
  it('accepts the agreed neutral action catalogue', () => {
    expect(auditActionSchema.safeParse('operation_complete').success).toBe(true);
    expect(auditActionSchema.safeParse('operation_completed').success).toBe(false);
  });

  it('requires a full user event with a partial operation summary', () => {
    expect(
      auditEventSchema.safeParse({
        id: '123e4567-e89b-42d3-a456-426614174000',
        schemaVersion: 1,
        occurredAt: timestamp,
        recordedAt: timestamp,
        action: 'operation_complete',
        actor: { type: 'user', id: '42', displayName: 'Иван Петров' },
        subject: { type: 'operation', id: 'op-1', displayName: 'Массовое изменение' },
        relatedObjects: [],
        outcome: 'partial',
        correlationId,
        details: {
          kind: 'operation',
          reasonCode: null,
          summary: {
            selected: 10,
            successful: 8,
            failed: 1,
            unconfirmed: 0,
            conflicted: 1,
            partiallyApplied: 0,
            notProcessed: 0,
          },
        },
      }).success,
    ).toBe(true);
  });

  it('rejects a missing correlation ID and a partial non-operation result', () => {
    expect(
      auditWriteEventSchema.safeParse({
        occurredAt: timestamp,
        action: 'report_download',
        actor: { type: 'user', id: '42', displayName: 'Иван Петров' },
        subject: { type: 'report', id: 'report-1', displayName: 'Отчёт XLSX' },
        relatedObjects: [],
        outcome: 'partial',
        deduplicationScope: 'request-1',
        eventSlot: 'result',
        details: {
          kind: 'report',
          formats: ['xlsx'],
          stage: 'download',
          errorCode: null,
          retryable: null,
        },
      }).success,
    ).toBe(false);
  });

  it('shows an unknown future action without exposing its details', () => {
    expect(
      parseAuditEventForRead({
        id: '123e4567-e89b-42d3-a456-426614174000',
        schemaVersion: 2,
        occurredAt: timestamp,
        recordedAt: timestamp,
        action: 'future_action',
        actor: { type: 'system', source: 'internal', displayName: 'Система' },
        subject: { type: 'system', id: 'component', displayName: 'Компонент' },
        relatedObjects: [],
        outcome: 'success',
        correlationId,
        details: { token: 'must not be returned' },
      }),
    ).toMatchObject({ action: 'future_action', details: null });
  });
});
