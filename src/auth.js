import crypto from 'node:crypto';
import { ADMIN_PASSWORD, ADMIN_SECRET } from './config.js';
import { getSetting, setSetting } from './db.js';

/**
 * Admin auth is a password -> scrypt hash in the settings table, compared with
 * timingSafeEqual. Sessions are stateless signed cookies so the server can be
 * restarted mid-party without logging the admin out.
 */

const COOKIE = 'cv_admin';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

export function ensureAdminPassword() {
  if (getSetting('admin_password')) return null;
  const pw = ADMIN_PASSWORD || crypto.randomBytes(6).toString('base64url');
  setSetting('admin_password', hashPassword(pw));
  return ADMIN_PASSWORD ? null : pw;
}

export function checkPassword(pw) {
  const stored = getSetting('admin_password');
  return stored ? verifyPassword(pw, stored) : false;
}

export function changePassword(current, next) {
  if (!checkPassword(current)) return false;
  setSetting('admin_password', hashPassword(next));
  return true;
}

/**
 * Drop every session cookie that has already been issued.
 *
 * The signing key is independent of the password, so changing the password
 * alone leaves anyone holding a valid cookie logged in — which is exactly
 * wrong when the reason for the change is that the old one leaked. Rotating
 * the key invalidates all outstanding cookies, including the caller's, so the
 * caller re-issues its own session straight afterwards.
 */
export function invalidateSessions() {
  setSetting('session_secret', crypto.randomBytes(32).toString('hex'));
}

function secret() {
  let s = getSetting('session_secret');
  if (!s) {
    s = crypto.randomBytes(32).toString('hex');
    setSetting('session_secret', s);
  }
  return s;
}

/**
 * `Secure` must be decided per request, not from a static env var.
 *
 * Behind Cloudflare every request arrives over HTTPS, so the cookie needs the
 * flag. But the host will inevitably open http://<vm-ip>:3000/admin while
 * setting things up, and a `Secure` cookie is silently dropped by the browser
 * there — the admin would be stuck re-entering a password that "worked".
 * Deriving it from the actual request means both paths just work.
 */
export function shouldUseSecureCookie(req) {
  if (process.env.FORCE_SECURE_COOKIE === '1') return true;
  if (process.env.FORCE_INSECURE_COOKIE === '1') return false;
  return req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

export function issueSession(req, res) {
  const payload = JSON.stringify({ exp: Date.now() + SESSION_TTL_MS });
  const body = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  res.cookie(COOKIE, `${body}.${sig}`, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: shouldUseSecureCookie(req),
    maxAge: SESSION_TTL_MS,
  });
}

export function clearSession(res) {
  res.clearCookie(COOKIE);
}

export function isAdmin(req) {
  const raw = req.cookies?.[COOKIE];
  if (!raw) return false;
  const [body, sig] = raw.split('.');
  if (!body || !sig) return false;
  const expected = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(body, 'base64url').toString());
    return Date.now() < exp;
  } catch {
    return false;
  }
}

/** Gate for admin pages: redirects browsers to the login screen. */
export function requireAdminPage(req, res, next) {
  if (isAdmin(req)) return next();
  res.redirect('/admin/login');
}

/** Gate for admin JSON endpoints. */
export function requireAdminApi(req, res, next) {
  if (isAdmin(req)) return next();
  res.status(401).json({ error: 'Admin login required' });
}