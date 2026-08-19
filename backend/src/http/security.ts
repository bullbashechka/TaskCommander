import { ApiHttpError } from './errors';

import type { RuntimeEnvironment } from '../runtime/configuration';
import { canonicalOrigin, configuredOrigins } from '../runtime/origin-policy';

const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function haveEqualSecretValues(left: string | undefined, right: string | null): boolean {
  if (!left || right === null) return false;
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

export async function requireRateLimit(binding: RateLimit | undefined, key: string): Promise<void> {
  if (!binding) throw new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
  const result = await binding.limit({ key });
  if (!result.success) throw new ApiHttpError(429, 'RATE_LIMITED');
}

export function clientRateLimitKey(request: Request): string {
  const address = request.headers.get('cf-connecting-ip')?.trim();
  return address && address.length <= 64 ? address : 'unknown-client';
}

export { configuredOrigins } from '../runtime/origin-policy';

export function getApplicationOrigin(env: RuntimeEnvironment): string | null {
  const configured = canonicalOrigin(env.APP_ORIGIN ?? '', env.APP_ENV === 'local');
  return configured;
}

export function requireSameOriginJsonRequest(env: RuntimeEnvironment, request: Request): void {
  if (!unsafeMethods.has(request.method)) return;

  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  const expectedOrigin = getApplicationOrigin(env);
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  if (
    contentType !== 'application/json' ||
    expectedOrigin === null ||
    origin !== expectedOrigin ||
    (fetchSite !== 'same-origin' && fetchSite !== 'same-site')
  ) {
    throw new ApiHttpError(400, 'INVALID_REQUEST');
  }
}

export function securityHeaders(env: RuntimeEnvironment): Headers {
  const frameAncestors = configuredOrigins(
    env.BITRIX_FRAME_ANCESTORS ?? env.BITRIX_PORTAL_ORIGIN,
    env.APP_ENV === 'local',
  );
  const mediaOrigins = configuredOrigins(env.BITRIX_MEDIA_ALLOWED_ORIGINS, env.APP_ENV === 'local');
  const imageOrigins = [
    ...new Set([
      ...configuredOrigins(env.BITRIX_PORTAL_ORIGIN, env.APP_ENV === 'local'),
      ...mediaOrigins,
    ]),
  ];
  const headers = new Headers({
    'content-security-policy': [
      "default-src 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      "form-action 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "style-src-attr 'none'",
      "connect-src 'self'",
      `img-src 'self'${imageOrigins.length ? ` ${imageOrigins.join(' ')}` : ''}`,
      `frame-ancestors ${frameAncestors.length ? frameAncestors.join(' ') : "'none'"}`,
    ].join('; '),
    'permissions-policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  if (env.APP_ENV !== 'local') {
    headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
  return headers;
}

export function applySecurityHeaders(response: Response, env: RuntimeEnvironment): Response {
  const headers = new Headers(response.headers);
  securityHeaders(env).forEach((value, name) => headers.set(name, value));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function isLoopbackRequest(request: Request): boolean {
  const hostname = new URL(request.url).hostname.toLowerCase();
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname) ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}
