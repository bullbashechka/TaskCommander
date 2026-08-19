export function canonicalOrigin(value: string, allowHttp = false): string | null {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const localHostname =
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname === '[::1]' ||
      hostname === '::1' ||
      /^127(?:\.\d{1,3}){3}$/.test(hostname);
    const transportAllowed =
      (url.protocol === 'https:' && (url.port === '' || url.port === '443')) ||
      (allowHttp && url.protocol === 'http:' && localHostname);
    if (
      !transportAllowed ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function configuredOrigins(value: string | undefined, allowHttp = false): readonly string[] {
  if (!value) return [];
  const origins = value
    .split(',')
    .map((entry) => canonicalOrigin(entry.trim(), allowHttp))
    .filter((entry): entry is string => entry !== null);
  return [...new Set(origins)];
}

export function hasValidConfiguredOrigins(value: string | undefined, allowHttp = false): boolean {
  if (!value) return false;
  const entries = value.split(',').map((entry) => entry.trim());
  return entries.length > 0 && entries.every((entry) => canonicalOrigin(entry, allowHttp) !== null);
}

export function parseAllowedServiceUrl(
  value: string | undefined,
  allowedOriginsValue: string | undefined,
): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (!hasValidConfiguredOrigins(allowedOriginsValue)) return null;
    const allowedOrigins = configuredOrigins(allowedOriginsValue);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      (url.port !== '' && url.port !== '443') ||
      !allowedOrigins.includes(url.origin)
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

export function isUrlFromOrigins(
  value: string,
  origins: readonly string[],
  allowHttp = false,
): boolean {
  try {
    const url = new URL(value);
    const exactOrigin = canonicalOrigin(url.origin, allowHttp);
    return exactOrigin !== null && !url.username && !url.password && origins.includes(exactOrigin);
  } catch {
    return false;
  }
}
