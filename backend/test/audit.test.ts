import { describe, expect, it } from 'vitest';

import { redactSensitiveAuditData } from '../src/data/audit';

describe('audit data redaction', () => {
  it('removes protected values and masks credentials before validation', () => {
    expect(
      redactSensitiveAuditData({
        errorCode: 'UPSTREAM_FAILURE',
        accessToken: 'secret-token',
        protectedPreviousValues: { deadline: '2026-08-10' },
        nested: {
          authorization: 'Bearer top-secret',
          callback: 'https://portal.example/rest/1/private-webhook/task.get?auth=secret',
        },
      }),
    ).toEqual({
      errorCode: 'UPSTREAM_FAILURE',
      nested: {
        callback: '[REDACTED_BITRIX_URL]',
      },
    });
  });
});
