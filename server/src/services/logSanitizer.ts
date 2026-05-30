const SENSITIVE_FIELD_NAMES = new Set([
  'apiKey',
  'api_key',
  'api_key_encrypted',
  'password',
  'password_encrypted',
  'secret',
  'token',
  'githubToken',
  'accessToken',
  'authorization',
  'x-api-key',
  'credentials',
  'passwd',
  'pwd',
  'backendApiSecret',
]);

const SENSITIVE_URL_PARAMS = [
  'key',
  'api_key',
  'apikey',
  'token',
  'access_token',
  'secret',
  'client_secret',
  'password',
  'auth',
];

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'cookie',
  'set-cookie',
]);

const GITHUB_TOKEN_RE = /\bgh[pousr]_[a-zA-Z0-9_]{20,}\b/g;
const GENERIC_SECRET_RE = /\b(?=[a-zA-Z0-9+/=_-]{24,}\b)(?=[a-zA-Z0-9+/=_-]*\d)[a-zA-Z0-9+/=_-]{24,}\b/g;
const EMAIL_RE = /\b[^@\s]+@[^@\s]+\.[^@\s]+\b/g;
const URL_RE = /https?:\/\/[^\s"'<>\\]+/gi;
const BEARER_RE = /\b(Bearer)\s+([a-zA-Z0-9._~+/=-]+)/gi;
const BASIC_RE = /\b(Basic)\s+([a-zA-Z0-9+/=-]+)/gi;

export function maskSecret(value: string): string {
  if (!value || value.length <= 4) return '****';
  return `***${value.slice(-4)}`;
}

export function maskEmail(email: string): string {
  const atIndex = email.indexOf('@');
  if (atIndex <= 0) return '***@***';
  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);
  return `${local.length <= 2 ? '**' : `${local[0]}***`}@${domain}`;
}

export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const [key] of parsed.searchParams) {
      if (SENSITIVE_URL_PARAMS.includes(key.toLowerCase())) {
        parsed.searchParams.set(key, '***');
      }
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

export function sanitizeForLog(input: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (input === null || input === undefined) return input;
  if (typeof input === 'string') return sanitizeString(input);
  if (typeof input === 'number' || typeof input === 'boolean') return input;
  if (typeof input === 'object') {
    if (seen.has(input)) return '[Circular]';
    seen.add(input);
    const result = Array.isArray(input)
      ? input.map((value) => sanitizeForLog(value, seen))
      : sanitizeObject(input as Record<string, unknown>, seen);
    seen.delete(input);
    return result;
  }
  return sanitizeString(String(input));
}

function sanitizeString(value: string): string {
  return value
    .replace(BEARER_RE, (_match, scheme: string, token: string) => `${scheme} ${maskSecret(token)}`)
    .replace(BASIC_RE, (_match, scheme: string) => `${scheme} ***`)
    .replace(URL_RE, (url) => redactUrl(url))
    .replace(GITHUB_TOKEN_RE, (token) => maskSecret(token))
    .replace(GENERIC_SECRET_RE, (secret) => maskSecret(secret))
    .replace(EMAIL_RE, (email) => maskEmail(email));
}

function sanitizeObject(obj: Record<string, unknown>, seen: WeakSet<object>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    if (
      SENSITIVE_FIELD_NAMES.has(key) ||
      SENSITIVE_FIELD_NAMES.has(lowerKey) ||
      lowerKey.includes('password') ||
      lowerKey.includes('passwd') ||
      lowerKey.includes('pwd') ||
      lowerKey.includes('token') ||
      lowerKey.includes('secret') ||
      lowerKey.includes('apikey')
    ) {
      result[key] = typeof value === 'string' ? maskSecret(value) : '****';
      continue;
    }

    if (typeof value === 'object' && value !== null && (lowerKey === 'headers' || lowerKey === 'header')) {
      result[key] = sanitizeHeaders(value as Record<string, unknown>, seen);
      continue;
    }

    result[key] = sanitizeForLog(value, seen);
  }
  return result;
}

function sanitizeHeaders(headers: Record<string, unknown>, seen: WeakSet<object>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    result[key] = SENSITIVE_HEADER_NAMES.has(lowerKey) || lowerKey.includes('session') || lowerKey.includes('csrf')
      ? typeof value === 'string' ? sanitizeString(value) : '****'
      : sanitizeForLog(value, seen);
  }
  return result;
}

export function sanitizeError(err: unknown): { message: string; stack?: string; name?: string } {
  if (!(err instanceof Error)) {
    return { message: sanitizeString(String(err)) };
  }
  return {
    name: err.name,
    message: sanitizeString(err.message),
    stack: err.stack ? sanitizeString(err.stack) : undefined,
  };
}
