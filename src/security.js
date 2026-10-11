import crypto from 'node:crypto';

function hmac(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

export function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function seal(value, secret) {
  const payload = Buffer.from(String(value), 'utf8').toString('base64url');
  return `${payload}.${hmac(payload, secret)}`;
}

export function unseal(value, secret) {
  if (!value || typeof value !== 'string') return null;
  const split = value.lastIndexOf('.');
  if (split < 1) return null;
  const payload = value.slice(0, split);
  const signature = value.slice(split + 1);
  if (!safeEqual(signature, hmac(payload, secret))) return null;
  try {
    return Buffer.from(payload, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

export function parseCookies(header = '') {
  const result = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) { try { result[key] = decodeURIComponent(value); } catch { /* Ignore malformed cookie values. */ } }
  }
  return result;
}

export function cookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || '/'}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite || 'Strict'}`);
  return parts.join('; ');
}

export function sessionId() {
  return crypto.randomBytes(24).toString('base64url');
}
