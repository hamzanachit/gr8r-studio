import { neon } from '@neondatabase/serverless';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export const COOKIE = 'gr8r_session';
export const SESSION_DAYS = 30;

let _sql = null;
export function getSql() {
  if (!_sql) _sql = neon(process.env.DATABASE_URL);
  return _sql;
}

let _schema = null;
export function ensureSchema() {
  if (!_schema) {
    const sql = getSql();
    _schema = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email text NOT NULL,
        name text NOT NULL,
        pw_hash text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (lower(email))`;
      await sql`CREATE TABLE IF NOT EXISTS sessions (
        token_hash text PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`;
      await sql`CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id)`;
      await sql`CREATE TABLE IF NOT EXISTS workspaces (
        user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        doc jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS login_attempts (
        key text PRIMARY KEY,
        fails int NOT NULL DEFAULT 0,
        locked_until timestamptz
      )`;
    })().catch(err => {
      _schema = null;
      throw err;
    });
  }
  return _schema;
}

/* ---------- passwords: scrypt, per-user salt ---------- */
const scryptAsync = (pw, salt) => new Promise((resolve, reject) => scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? reject(e) : resolve(k))));

export async function hashPassword(pw) {
  const salt = randomBytes(16);
  const key = await scryptAsync(pw, salt);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

export async function verifyPassword(pw, stored) {
  const [saltHex, keyHex] = String(stored).split(':');
  if (!saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scryptAsync(pw, Buffer.from(saltHex, 'hex'));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/* ---------- sessions: random token in httpOnly cookie, only its hash is stored ---------- */
const sha = s => createHash('sha256').update(s).digest('hex');

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const cookieAttrs = 'Path=/; HttpOnly; SameSite=Lax' + (process.env.VERCEL ? '; Secure' : '');

export async function createSession(res, userId) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  await getSql()`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (${sha(token)}, ${userId}, ${expires.toISOString()})`;
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; ${cookieAttrs}; Max-Age=${SESSION_DAYS * 86400}`);
}

export async function destroySession(req, res) {
  const token = parseCookies(req)[COOKIE];
  if (token) await getSql()`DELETE FROM sessions WHERE token_hash = ${sha(token)}`;
  res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieAttrs}; Max-Age=0`);
}

/** Returns {id, email, name} for the signed-in user, or null. */
export async function currentUser(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const rows = await getSql()`SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${sha(token)} AND s.expires_at > now()`;
  return rows[0] || null;
}

/** CSRF defence for cookie auth: state-changing requests must come from our own origin. */
export function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients / same-origin GETs
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}
