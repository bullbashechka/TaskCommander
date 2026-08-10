import { describe, expect, it } from 'vitest';

import {
  apiErrorResponseSchema,
  bulkOperationDraftSchema,
  bulkChangeCommandSchema,
  healthResponse,
  isHealthResponse,
  operationStatusSchema,
  reportTaskEntrySchema,
  taskOutcomeStatusSchema,
} from './index';

describe('health contract', () => {
  it('accepts the canonical response', () => {
    expect(isHealthResponse(healthResponse)).toBe(true);
  });

  it('rejects a response without runtime readiness', () => {
    expect(isHealthResponse({ status: 'ok', service: 'task-commander-api' })).toBe(false);
  });
});

describe('domain contracts', () => {
  it('accepts every agreed operation and task outcome status', () => {
    const operationStatuses = [
      'running',
      'completed',
      'completed_with_errors',
      'cancelled',
      'interrupted',
    ];
    const taskOutcomeStatuses = [
      'success',
      'error',
      'conflict',
      'excluded_by_preflight',
      'not_processed',
      'restored',
      'restore_error',
      'no_change',
      'partially_applied',
    ];

    expect(
      operationStatuses.every((status) => operationStatusSchema.safeParse(status).success),
    ).toBe(true);
    expect(
      taskOutcomeStatuses.every((status) => taskOutcomeStatusSchema.safeParse(status).success),
    ).toBe(true);
  });

  it('rejects operation statuses that are not part of the public contract', () => {
    expect(operationStatusSchema.safeParse('queued').success).toBe(false);
  });

  it('accepts the agreed task outcome extensions', () => {
    expect(taskOutcomeStatusSchema.safeParse('no_change').success).toBe(true);
    expect(taskOutcomeStatusSchema.safeParse('partially_applied').success).toBe(true);
  });

  it('rejects an invalid mixed date change command', () => {
    expect(
      bulkChangeCommandSchema.safeParse({
        fieldId: 'deadline',
        kind: 'date',
        action: 'set',
        value: '2026-08-10T09:00:00+05:00',
        days: 3,
      }).success,
    ).toBe(false);
  });

  it('rejects protected restoration values in the public report contract', () => {
    expect(
      reportTaskEntrySchema.safeParse({
        taskId: '42',
        title: 'Visible task',
        taskUrl: null,
        outcome: 'success',
        changedFieldIds: ['deadline'],
        protectedPreviousValues: { deadline: '2026-08-09T09:00:00+05:00' },
      }).success,
    ).toBe(false);
  });

  it('requires a correlation ID on every API error', () => {
    expect(
      apiErrorResponseSchema.safeParse({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Некорректный запрос.',
          correlationId: 'TC-123e4567-e89b-42d3-a456-426614174000',
        },
      }).success,
    ).toBe(true);
  });

  it('preserves a draft across JSON serialization', () => {
    const draft = {
      id: '123e4567-e89b-42d3-a456-426614174000',
      ownerId: '10',
      revision: 1,
      status: 'preparing',
      selectedTaskIds: ['42'],
      changes: [
        {
          fieldId: 'deadline',
          kind: 'date_time',
          action: 'shift',
          direction: 'forward',
          days: 3,
          calendar: 'working_days',
        },
      ],
      createdAt: '2026-08-10T09:00:00+05:00',
      updatedAt: '2026-08-10T09:00:00+05:00',
      expiresAt: '2026-08-11T09:00:00+05:00',
    };

    expect(bulkOperationDraftSchema.parse(JSON.parse(JSON.stringify(draft)))).toEqual(draft);
  });
});
