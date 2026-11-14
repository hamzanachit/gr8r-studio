import { createSession, currentUser, destroySession, ensureSchema, getSql, hashPassword, sameOrigin, verifyPassword } from './_lib.js';

const EMAIL_RE = /^\S+@\S+\.\S+$/;
const MAX_FAILS = 8;
const LOCK_MINUTES = 15;
const publicUser = u => ({ id: u.id, email: u.email, name: u.name });

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    await ensureSchema();
    const sql = getSql();

    if (req.method === 'GET') {
      const user = await currentUser(req);
      return res.status(200).json({ user: user ? publicUser(user) : null });
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'method not allowed' });
    }
    if (!sameOrigin(req)) return res.status(403).json({ error: 'forbidden' });

    const action = req.query.action;
    const body = req.body && typeof req.body === 'object' ? req.body : {};

    if (action === 'logout') {
      await destroySession(req, res);
      return res.status(200).json({ ok: true });
    }

    if (action === 'signup') {
      const name = String(body.name || '')
        .trim()
        .slice(0, 100);
      const email = String(body.email || '')
        .trim()
        .toLowerCase()
        .slice(0, 254);
      const pw = String(body.password || '');
      if (!name) return res.status(400).json({ error: 'Enter your name', field: 'name' });
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid work email', field: 'email' });
      if (pw.length < 10 || !/[0-9\W]/.test(pw) || pw.length > 200) {
        return res.status(400).json({ error: 'Use at least 10 characters, including a number or symbol', field: 'pw' });
      }
      const hash = await hashPassword(pw);
      const rows = await sql`INSERT INTO users (email, name, pw_hash) VALUES (${email}, ${name}, ${hash})
        ON CONFLICT DO NOTHING RETURNING id, email, name`;
      if (!rows.length) return res.status(409).json({ error: 'An account with this email already exists', field: 'email' });
      await createSession(res, rows[0].id);
      return res.status(201).json({ user: publicUser(rows[0]) });
    }

    if (action === 'login') {
      const email = String(body.email || '')
        .trim()
        .toLowerCase()
        .slice(0, 254);
      const pw = String(body.password || '').slice(0, 200);
      const key = `${email}|${req.headers['x-forwarded-for'] || ''}`.slice(0, 300);
      const [lock] = await sql`SELECT fails, locked_until FROM login_attempts WHERE key = ${key}`;
      if (lock?.locked_until && new Date(lock.locked_until) > new Date()) {
        return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
      }
      const [u] = await sql`SELECT id, email, name, pw_hash FROM users WHERE lower(email) = ${email}`;
      // verify against a dummy hash when the user is unknown so timing doesn't reveal which emails exist
      const ok = await verifyPassword(pw, u?.pw_hash || '00:00');
      if (!u || !ok) {
        await sql`INSERT INTO login_attempts (key, fails, locked_until) VALUES (${key}, 1, NULL)
          ON CONFLICT (key) DO UPDATE SET
            fails = CASE WHEN login_attempts.locked_until IS NOT NULL AND login_attempts.locked_until <= now() THEN 1 ELSE login_attempts.fails + 1 END,
            locked_until = CASE WHEN login_attempts.fails + 1 >= ${MAX_FAILS} THEN now() + ${LOCK_MINUTES + ' minutes'}::interval ELSE NULL END`;
        return res.status(401).json({ error: 'Incorrect email or password' });
      }
      await sql`DELETE FROM login_attempts WHERE key = ${key}`;
      await createSession(res, u.id);
      return res.status(200).json({ user: publicUser(u) });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (err) {
    console.error('auth api error', err);
    return res.status(500).json({ error: 'server error' });
  }
}
