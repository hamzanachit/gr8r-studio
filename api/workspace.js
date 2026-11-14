import { currentUser, ensureSchema, getSql, sameOrigin } from './_lib.js';

const MAX_BYTES = 4 * 1024 * 1024; // Vercel body limit is 4.5 MB

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    await ensureSchema();
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: 'not signed in' });
    const sql = getSql();

    if (req.method === 'GET') {
      const rows = await sql`SELECT doc, updated_at FROM workspaces WHERE user_id = ${user.id}`;
      if (!rows.length) return res.status(200).json({ doc: null });
      return res.status(200).json({ doc: rows[0].doc, updatedAt: rows[0].updated_at });
    }

    if (req.method === 'PUT') {
      if (!sameOrigin(req)) return res.status(403).json({ error: 'forbidden' });
      const body = req.body;
      if (!body || typeof body !== 'object' || !body.data || !Array.isArray(body.data.tasks)) {
        return res.status(400).json({ error: 'invalid workspace payload' });
      }
      const json = JSON.stringify(body);
      if (Buffer.byteLength(json) > MAX_BYTES) return res.status(413).json({ error: 'payload too large' });
      await sql`INSERT INTO workspaces (user_id, doc, updated_at) VALUES (${user.id}, ${json}::jsonb, now())
        ON CONFLICT (user_id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()`;
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    console.error('workspace api error', err);
    return res.status(500).json({ error: 'server error' });
  }
}
