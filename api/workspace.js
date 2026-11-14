import { currentUser, ensureSchema, getSql, sameOrigin } from './_lib.js';

/*
 * A workspace is stored as many small "parts" (rows) instead of one big document, so there is no
 * per-account size ceiling: every request carries at most ~3 MB (Vercel's body limit is 4.5 MB),
 * reads are paged, and a save only sends the parts that changed.
 *
 *   GET  /api/workspace?after=<part>   -> { parts: {name: json}, next: <part>|null }   (one page)
 *   PUT  /api/workspace  { parts: {name: json}, names?: [name] }
 *        `names` (the full list of parts that should exist) is sent with the last request of a save;
 *        parts not in it are deleted.
 */
const PAGE_BYTES = 3 * 1024 * 1024;
const MAX_REQUEST_BYTES = 3.5 * 1024 * 1024;
const MAX_PART_BYTES = 3 * 1024 * 1024;
const MAX_ACCOUNT_BYTES = 500 * 1024 * 1024;
const PART_RE = /^[A-Za-z0-9_.:-]{1,80}$/;

async function readParts(sql, userId, after) {
  const index = await sql`SELECT part, bytes FROM workspace_parts WHERE user_id = ${userId} AND part COLLATE "C" > ${after} COLLATE "C"
    ORDER BY part COLLATE "C" LIMIT 500`;
  const chosen = [];
  let total = 0;
  for (const r of index) {
    if (chosen.length && total + r.bytes > PAGE_BYTES) break;
    chosen.push(r.part);
    total += r.bytes;
  }
  const parts = {};
  if (chosen.length) {
    const rows = await sql`SELECT part, doc FROM workspace_parts WHERE user_id = ${userId} AND part = ANY(${chosen})`;
    for (const r of rows) parts[r.part] = r.doc;
  }
  const last = chosen[chosen.length - 1];
  const more = chosen.length < index.length || index.length === 500;
  return { parts, next: more && last ? last : null, empty: !index.length && after === '' };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    await ensureSchema();
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: 'not signed in' });
    const sql = getSql();

    if (req.method === 'GET') {
      const after = typeof req.query.after === 'string' ? req.query.after.slice(0, 80) : '';
      const page = await readParts(sql, user.id, after);
      if (page.empty) {
        // accounts created before parts existed: hand over the old single document once
        const legacy = await sql`SELECT doc FROM workspaces WHERE user_id = ${user.id}`;
        return res.status(200).json({ parts: {}, next: null, legacy: legacy[0]?.doc || null });
      }
      return res.status(200).json({ parts: page.parts, next: page.next });
    }

    if (req.method === 'PUT') {
      if (!sameOrigin(req)) return res.status(403).json({ error: 'forbidden' });
      const { parts, names } = req.body || {};
      if (!parts || typeof parts !== 'object' || Array.isArray(parts)) return res.status(400).json({ error: 'invalid payload' });
      if (names != null && (!Array.isArray(names) || names.length > 100000 || !names.every(n => typeof n === 'string' && PART_RE.test(n)))) {
        return res.status(400).json({ error: 'invalid part list' });
      }
      const entries = Object.entries(parts);
      let requestBytes = 0;
      const rows = [];
      for (const [name, value] of entries) {
        if (!PART_RE.test(name)) return res.status(400).json({ error: 'invalid part name' });
        const json = JSON.stringify(value);
        const bytes = Buffer.byteLength(json);
        if (bytes > MAX_PART_BYTES) return res.status(413).json({ error: `part ${name} too large` });
        requestBytes += bytes;
        rows.push({ name, json, bytes });
      }
      if (requestBytes > MAX_REQUEST_BYTES) return res.status(413).json({ error: 'request too large' });

      if (rows.length) {
        const [{ used }] = await sql`SELECT COALESCE(SUM(bytes), 0)::bigint AS used FROM workspace_parts WHERE user_id = ${user.id}`;
        if (Number(used) + requestBytes > MAX_ACCOUNT_BYTES) return res.status(413).json({ error: 'account storage limit reached' });
        await sql.transaction(
          rows.map(
            r => sql`INSERT INTO workspace_parts (user_id, part, doc, bytes, updated_at)
              VALUES (${user.id}, ${r.name}, ${r.json}::jsonb, ${r.bytes}, now())
              ON CONFLICT (user_id, part) DO UPDATE SET doc = EXCLUDED.doc, bytes = EXCLUDED.bytes, updated_at = now()`,
          ),
        );
      }
      if (names) {
        if (!names.includes('root')) return res.status(400).json({ error: 'part list must include root' });
        await sql`DELETE FROM workspace_parts WHERE user_id = ${user.id} AND NOT (part = ANY(${names}))`;
        await sql`DELETE FROM workspaces WHERE user_id = ${user.id}`; // legacy single-document row, now migrated
      }
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    console.error('workspace api error', err);
    return res.status(500).json({ error: 'server error' });
  }
}
