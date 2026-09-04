import { describe, expect, it } from 'vitest';

import {
  bitrixFailureSchema,
  notificationRequestSchema,
  taskApplyRequestSchema,
  taskChangeSnapshotSchema,
  taskSearchRequestSchema,
} from '../src/integrations/bitrix/schemas';

describe('Bitrix adapter schemas', () => {
  it('accepts a normalized task search request', () => {
    expect(
      taskSearchRequestSchema.parse({
        filters: [
          {
            kind: 'text',
            fieldId: 'title',
            operator: 'contains',
            values: ['release'],
          },
        ],
        sort: { fieldId: 'deadline', direction: 'asc' },
        page: 1,
        pageSize: 50,
      }),
    ).toMatchObject({ page: 1, pageSize: 50 });
  });

  it('rejects a task search page range outside safe integer arithmetic', () => {
    expect(
      taskSearchRequestSchema.safeParse({
        filters: [],
        sort: { fieldId: 'deadline', direction: 'asc' },
        page: Number.MAX_SAFE_INTEGER,
        pageSize: 2,
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown upstream failure kind', () => {
    expect(
      bitrixFailureSchema.safeParse({ kind: 'raw_bitrix_error', diagnosticCode: 'ERROR_CORE' })
        .success,
    ).toBe(false);
  });

  it('allows only HTTPS or exact loopback HTTP application links', () => {
    const request = {
      recipientId: '42',
      deduplicationKey: 'operation-42',
      message: 'Operation completed.',
    };
    expect(
      notificationRequestSchema.safeParse({
        ...request,
        operationUrl: 'http://localhost:5173/operations/42',
      }).success,
    ).toBe(true);
    expect(
      notificationRequestSchema.safeParse({
        ...request,
        operationUrl: 'http://attacker.example/operations/42',
      }).success,
    ).toBe(false);
  });

  it('requires a relevant version and normalized target values for a task update', () => {
    const snapshot = taskChangeSnapshotSchema.parse({
      taskId: '42',
      title: 'Quarterly report',
      taskUrl: 'https://portal.bitrix24.ru/company/personal/user/1/tasks/task/view/42/',
      status: 'in_progress',
      values: { deadline: '2026-08-14T10:00:00+05:00' },
      editableFieldIds: ['deadline'],
      deadlineManagedBySubtasks: false,
      relevantVersion: 'dGVzdC12ZXJzaW9u',
    });

    expect(
      taskApplyRequestSchema.parse({
        taskId: snapshot.taskId,
        expectedRelevantVersion: snapshot.relevantVersion,
        targetValues: { deadline: '2026-08-18T10:00:00+05:00' },
      }),
    ).toMatchObject({ taskId: '42' });
  });
});
