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

const GITHUB_TOKEN_RE = /^ghp_[a-zA-Z0-9]{36}$/;
const GENERIC_SECRET_RE = /^[a-zA-Z0-9+/=_-]{20,}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

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
  if (GITHUB_TOKEN_RE.test(value)) return maskSecret(value);
  if (value.length >= 20 && GENERIC_SECRET_RE.test(value)) return maskSecret(value);
  if (EMAIL_RE.test(value)) return maskEmail(value);
  if (value.startsWith('http://') || value.startsWith('https://')) return redactUrl(value);
  if (value.startsWith('Bearer ') || value.startsWith('bearer ')) {
    return `${value.slice(0, 7)}${maskSecret(value.slice(7))}`;
  }
  if (value.startsWith('Basic ') || value.startsWith('basic ')) {
    return `${value.slice(0, 6)}***`;
  }
  return value;
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
    result[key] = lowerKey === 'authorization' || lowerKey === 'x-api-key'
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
