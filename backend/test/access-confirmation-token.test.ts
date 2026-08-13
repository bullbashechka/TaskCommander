import { describe, expect, it } from 'vitest';

import {
  createAccessConfirmationToken,
  InvalidSignedTokenError,
  verifyAccessConfirmationToken,
} from '../src/auth/signed-token';

const secret = 'test-access-confirmation-secret-000000001';
const issuedAt = new Date('2026-08-13T10:00:00.000Z');

describe('access confirmation token', () => {
  it('binds a short-lived token to portal, actor, preflight, and draft revision', async () => {
    const created = await createAccessConfirmationToken(
      {
        portalId: 'test-portal',
        actorUserId: '20',
        preflightId: '123e4567-e89b-42d3-a456-426614174000',
        draftRevision: 3,
      },
      secret,
      issuedAt,
      '223e4567-e89b-42d3-a456-426614174000',
    );

    await expect(
      verifyAccessConfirmationToken(
        created.token,
        secret,
        new Date('2026-08-13T10:04:59.000Z'),
      ),
    ).resolves.toMatchObject({
      confirmationId: '223e4567-e89b-42d3-a456-426614174000',
      portalId: 'test-portal',
      actorUserId: '20',
      draftRevision: 3,
    });
  });

  it('rejects an expired or tampered token', async () => {
    const created = await createAccessConfirmationToken(
      {
        portalId: 'test-portal',
        actorUserId: '20',
        preflightId: '123e4567-e89b-42d3-a456-426614174000',
        draftRevision: 3,
      },
      secret,
      issuedAt,
    );

    await expect(
      verifyAccessConfirmationToken(
        created.token,
        secret,
        new Date('2026-08-13T10:05:00.000Z'),
      ),
    ).rejects.toBeInstanceOf(InvalidSignedTokenError);
    await expect(
      verifyAccessConfirmationToken(`${created.token.slice(0, -1)}x`, secret, issuedAt),
    ).rejects.toBeInstanceOf(InvalidSignedTokenError);
  });
});
