import { describe, expect, it } from 'vitest';

import { createAuditAppendRequest, redactSensitiveAuditData } from '../src/data/audit';

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

  it('redacts basic credentials, JWTs, service keys and encoded query secrets', () => {
    expect(
      redactSensitiveAuditData({
        basic: 'Basic dXNlcjpwYXNzd29yZA==',
        jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature',
        key: 'sb_secret_abcdefghijklmnopqrstuvwxyz',
        url: 'https://example.test/?api_key%3Dsecret-value',
        encodedBasic: 'Basic%20dXNlcjpwYXNzd29yZA%3D%3D',
        encodedCredentialUrl: 'https%3A%2F%2Fuser%3Apassword%40example.test%2Fpath',
      }),
    ).toEqual({
      basic: 'Basic [REDACTED]',
      key: '[REDACTED_KEY]',
      url: 'https://example.test/?api_key%3D[REDACTED]',
      encodedBasic: '[REDACTED_ENCODED_AUTH]',
      encodedCredentialUrl: '[REDACTED_CREDENTIAL_URL]example.test%2Fpath',
    });
  });

  it('removes secret canaries from every audit object branch', () => {
    const canary = 'Bearer abcdefghijklmnopqrstuvwxyz.0123456789';
    const redacted = redactSensitiveAuditData({
      actor: { displayName: canary },
      subject: { displayName: canary },
      relatedObjects: [{ displayName: canary }],
      details: { reasonCode: canary },
    });

    expect(JSON.stringify(redacted)).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('rejects opaque values in action-specific audit code fields', () => {
    expect(() =>
      createAuditAppendRequest({
        portalId: 'portal-1',
        event: {
          occurredAt: '2026-08-18T00:00:00.000Z',
          action: 'system_error',
          actor: { type: 'system', source: 'internal', displayName: 'Система' },
          subject: { type: 'system', id: 'runtime', displayName: 'Runtime' },
          relatedObjects: [],
          outcome: 'failure',
          correlationId: 'TC-123e4567-e89b-42d3-a456-426614174000',
          deduplicationScope: 'runtime',
          eventSlot: 'error',
          details: {
            kind: 'system',
            component: 'operation-state-machine',
            errorCode: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
            retryable: false,
          },
        },
      }),
    ).toThrow();
  });
});
