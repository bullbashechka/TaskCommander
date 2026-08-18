import { z } from 'zod';

import {
  accessManagementLimits,
  bitrixIdSchema,
  portalIdSchema,
  sessionPrincipalSchema,
} from '@task-commander/contracts';

const encoder = new TextEncoder();

const mockLaunchAudience = 'task-commander.mock-launch';
const sessionAudience = 'task-commander.session';
const accessConfirmationAudience = 'task-commander.access-confirmation';
const mockLaunchHeader = { alg: 'HS256', typ: 'TC-MOCK-LAUNCH' } as const;
const sessionHeader = { alg: 'HS256', typ: 'TC-SESSION' } as const;
const accessConfirmationHeader = { alg: 'HS256', typ: 'TC-ACCESS-CONFIRMATION' } as const;
const mockLaunchLifetimeSeconds = 300;
const sessionLifetimeSeconds = 900;
const accessConfirmationLifetimeSeconds = accessManagementLimits.confirmationTtlSeconds;
const clockSkewSeconds = 60;

const timestampSchema = z.number().int().nonnegative();
const mockLaunchClaimsSchema = z
  .object({
    v: z.literal(1),
    aud: z.literal(mockLaunchAudience),
    portalId: portalIdSchema,
    userId: z.string().regex(/^\d+$/).min(1),
    iat: timestampSchema,
    exp: timestampSchema,
    nonce: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  })
  .strict();
const sessionClaimsSchema = z
  .object({
    v: z.literal(1),
    aud: z.literal(sessionAudience),
    sessionId: z.string().uuid(),
    portalId: portalIdSchema,
    userId: z.string().regex(/^\d+$/).min(1),
    displayName: z.string().trim().min(1).max(256),
    isBitrixAdmin: z.boolean(),
    iat: timestampSchema,
    exp: timestampSchema,
  })
  .strict();
const accessConfirmationClaimsSchema = z
  .object({
    v: z.literal(1),
    aud: z.literal(accessConfirmationAudience),
    confirmationId: z.string().uuid(),
    portalId: portalIdSchema,
    actorUserId: bitrixIdSchema,
    preflightId: z.string().uuid(),
    draftRevision: z.number().int().positive(),
    iat: timestampSchema,
    exp: timestampSchema,
  })
  .strict();

export type MockLaunchClaims = z.infer<typeof mockLaunchClaimsSchema>;
export type SessionClaims = z.infer<typeof sessionClaimsSchema>;
export type AccessConfirmationClaims = z.infer<typeof accessConfirmationClaimsSchema>;

export class SignedTokenConfigurationError extends Error {
  public constructor() {
    super('Signing configuration is invalid.');
  }
}

export class InvalidSignedTokenError extends Error {
  public constructor() {
    super('Signed token is invalid.');
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new InvalidSignedTokenError();
  }

  try {
    const padded = `${value}${'='.repeat((4 - (value.length % 4)) % 4)}`;
    const binary = atob(padded.replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (toBase64Url(bytes) !== value) {
      throw new InvalidSignedTokenError();
    }
    return bytes;
  } catch {
    throw new InvalidSignedTokenError();
  }
}

function parsePart(value: string): unknown {
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(fromBase64Url(value)),
    ) as unknown;
  } catch {
    throw new InvalidSignedTokenError();
  }
}

function getSecretKey(secret: string | undefined): Promise<CryptoKey> {
  if (secret === undefined) {
    throw new SignedTokenConfigurationError();
  }

  const secretBytes = encoder.encode(secret);
  if (secretBytes.byteLength < 32) {
    throw new SignedTokenConfigurationError();
  }

  return crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

async function signPayload(payload: string, secret: string | undefined): Promise<string> {
  const signature = await crypto.subtle.sign(
    'HMAC',
    await getSecretKey(secret),
    encoder.encode(payload),
  );
  return toBase64Url(new Uint8Array(signature));
}

async function encodeSignedToken(
  header: Record<string, string>,
  claims: Record<string, unknown>,
  secret: string | undefined,
): Promise<string> {
  const payload = `${toBase64Url(encoder.encode(JSON.stringify(header)))}.${toBase64Url(
    encoder.encode(JSON.stringify(claims)),
  )}`;
  return `${payload}.${await signPayload(payload, secret)}`;
}

async function verifySignedToken(
  token: string,
  expectedHeader: Record<string, string>,
  secret: string | undefined,
): Promise<unknown> {
  if (token.length === 0 || token.length > 4_096) {
    throw new InvalidSignedTokenError();
  }

  const parts = token.split('.');
  const [encodedHeader, encodedClaims, encodedSignature] = parts;
  if (
    parts.length !== 3 ||
    encodedHeader === undefined ||
    encodedClaims === undefined ||
    encodedSignature === undefined
  ) {
    throw new InvalidSignedTokenError();
  }

  const parsedHeader = z
    .object({ alg: z.literal('HS256'), typ: z.string() })
    .strict()
    .safeParse(parsePart(encodedHeader));
  if (!parsedHeader.success || parsedHeader.data.typ !== expectedHeader.typ) {
    throw new InvalidSignedTokenError();
  }

  const signature = fromBase64Url(encodedSignature);
  if (signature.byteLength !== 32) {
    throw new InvalidSignedTokenError();
  }

  const verified = await crypto.subtle.verify(
    'HMAC',
    await getSecretKey(secret),
    Uint8Array.from(signature),
    encoder.encode(`${encodedHeader}.${encodedClaims}`),
  );
  if (!verified) {
    throw new InvalidSignedTokenError();
  }

  return parsePart(encodedClaims);
}

function getCurrentTimestamp(now: Date): number {
  return Math.floor(now.getTime() / 1_000);
}

function assertTimestampWindow(
  claims: { iat: number; exp: number },
  now: Date,
  lifetimeSeconds: number,
): void {
  const currentTimestamp = getCurrentTimestamp(now);
  if (
    claims.exp <= claims.iat ||
    claims.exp - claims.iat !== lifetimeSeconds ||
    claims.iat > currentTimestamp + clockSkewSeconds ||
    claims.exp <= currentTimestamp
  ) {
    throw new InvalidSignedTokenError();
  }
}

export interface CreateMockLaunchContextInput {
  portalId: string;
  userId: string;
  nonce?: string;
  issuedAt?: number;
  expiresAt?: number;
  version?: number;
  audience?: string;
  headerType?: string;
  claims?: Record<string, unknown>;
}

export async function createMockLaunchContext(
  input: CreateMockLaunchContextInput,
  secret: string,
): Promise<string> {
  const issuedAt = input.issuedAt ?? getCurrentTimestamp(new Date());
  const claims: Record<string, unknown> = {
    v: input.version ?? 1,
    aud: input.audience ?? mockLaunchAudience,
    portalId: input.portalId,
    userId: input.userId,
    iat: issuedAt,
    exp: input.expiresAt ?? issuedAt + mockLaunchLifetimeSeconds,
    nonce: input.nonce ?? crypto.randomUUID().replaceAll('-', ''),
    ...input.claims,
  };
  return encodeSignedToken(
    { ...mockLaunchHeader, typ: input.headerType ?? mockLaunchHeader.typ },
    claims,
    secret,
  );
}

export async function verifyMockLaunchContext(
  token: string,
  secret: string | undefined,
  now = new Date(),
): Promise<MockLaunchClaims> {
  const parsed = mockLaunchClaimsSchema.safeParse(
    await verifySignedToken(token, mockLaunchHeader, secret),
  );
  if (!parsed.success) {
    throw new InvalidSignedTokenError();
  }
  assertTimestampWindow(parsed.data, now, mockLaunchLifetimeSeconds);
  return parsed.data;
}

export async function createSessionToken(
  principal: z.infer<typeof sessionPrincipalSchema>,
  secret: string | undefined,
  now = new Date(),
  sessionId: string = crypto.randomUUID(),
): Promise<string> {
  const issuedAt = getCurrentTimestamp(now);
  const claims: SessionClaims = sessionClaimsSchema.parse({
    v: 1,
    aud: sessionAudience,
    sessionId,
    ...principal,
    iat: issuedAt,
    exp: issuedAt + sessionLifetimeSeconds,
  });
  return encodeSignedToken(sessionHeader, claims, secret);
}

export async function verifySessionToken(
  token: string,
  secret: string | undefined,
  now = new Date(),
): Promise<SessionClaims> {
  const parsed = sessionClaimsSchema.safeParse(
    await verifySignedToken(token, sessionHeader, secret),
  );
  if (!parsed.success) {
    throw new InvalidSignedTokenError();
  }
  assertTimestampWindow(parsed.data, now, sessionLifetimeSeconds);
  return parsed.data;
}

export async function createAccessConfirmationToken(
  input: {
    portalId: string;
    actorUserId: string;
    preflightId: string;
    draftRevision: number;
  },
  secret: string | undefined,
  now = new Date(),
  confirmationId = crypto.randomUUID(),
): Promise<{ token: string; claims: AccessConfirmationClaims }> {
  const issuedAt = getCurrentTimestamp(now);
  const claims = accessConfirmationClaimsSchema.parse({
    v: 1,
    aud: accessConfirmationAudience,
    confirmationId,
    ...input,
    iat: issuedAt,
    exp: issuedAt + accessConfirmationLifetimeSeconds,
  });
  return {
    token: await encodeSignedToken(accessConfirmationHeader, claims, secret),
    claims,
  };
}

export async function verifyAccessConfirmationToken(
  token: string,
  secret: string | undefined,
  now = new Date(),
): Promise<AccessConfirmationClaims> {
  const parsed = accessConfirmationClaimsSchema.safeParse(
    await verifySignedToken(token, accessConfirmationHeader, secret),
  );
  if (!parsed.success) throw new InvalidSignedTokenError();
  assertTimestampWindow(parsed.data, now, accessConfirmationLifetimeSeconds);
  return parsed.data;
}
