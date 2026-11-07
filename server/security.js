import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';

const csrfSigningSecret = process.env.MANUS_JWT_SECRET || randomBytes(32).toString('hex');

export const STUDENT_COOKIE = 'khanyonis_student_session';
export const ADMIN_COOKIE = 'khanyonis_admin_session';
export const CSRF_COOKIE = 'khanyonis_csrf_token';

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function hashOpaqueToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function cookiePolicy() {
  // Managed Cloud has a public HTTPS origin even when its app process receives HTTP.
  const secure = Boolean(process.env.MANUS_PROJECT_ID) || process.env.APP_COOKIE_SECURE === 'true';
  return { httpOnly: true, secure, sameSite: secure ? 'none' : 'lax', path: '/' };
}

export function setCookie(res, name, value, options = {}) {
  res.cookie(name, value, { ...cookiePolicy(), ...options });
}

export function clearCookie(res, name, options = {}) {
  res.clearCookie(name, { ...cookiePolicy(), ...options });
}

export function getCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (key !== name) continue;
    try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return ''; }
  }
  return '';
}

export function createCsrfToken() {
  const nonce = randomToken(32);
  const signature = createHmac('sha256', csrfSigningSecret).update(nonce).digest('base64url');
  return `${nonce}.${signature}`;
}

export function verifyCsrfToken(token) {
  if (typeof token !== 'string') return false;
  const separator = token.lastIndexOf('.');
  if (separator < 1) return false;
  const nonce = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expected = createHmac('sha256', csrfSigningSecret).update(nonce).digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function requireCsrf(req, res, next) {
  const cookieToken = getCookie(req, CSRF_COOKIE);
  const headerToken = req.get('x-csrf-token') || '';
  if (!cookieToken || cookieToken !== headerToken || !verifyCsrfToken(cookieToken)) {
    return res.status(403).json({ error: 'Your security token expired. Refresh the page and try again.', code: 'CSRF_INVALID' });
  }
  return next();
}

export async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password, hash) {
  try { return await bcrypt.compare(password, hash); } catch { return false; }
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

export function signPlatformJwt(payload, secret = process.env.MANUS_JWT_SECRET) {
  if (!secret) throw new Error('MANUS_JWT_SECRET is required for admin authentication');
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const input = `${header}.${body}`;
  const signature = createHmac('sha256', secret).update(input).digest('base64url');
  return `${input}.${signature}`;
}

export function verifyPlatformJwt(token, secret = process.env.MANUS_JWT_SECRET) {
  if (!secret || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (header.alg !== 'HS256' || typeof payload !== 'object' || !payload) return null;
    const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
    const supplied = Buffer.from(parts[2], 'base64url');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) <= now) return null;
    if (Number.isFinite(Number(payload.nbf)) && Number(payload.nbf) > now) return null;
    if (!payload.appId || String(payload.appId) !== String(process.env.MANUS_PROJECT_ID || '')) return null;
    if (!payload.openId || typeof payload.openId !== 'string') return null;
    return payload;
  } catch {
    return null;
  }
}
