// Lets Claude Code add/update projects and tasks in a user's Gr8r workspace (Neon).
// Usage: node scripts/claude-tasks.mjs <email> <plan.json>
// plan.json: { "project": {"key":"GB","name":"..","desc":".."}, "tasks": [{"title","status","priority","desc","due"}] }
// Tasks are matched by title within the project, so re-running updates status instead of duplicating.
import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fromParts, toParts } from '../src/core/parts.js';

process.loadEnvFile('.env.local');
const [email, planFile] = process.argv.slice(2);
if (!email || !planFile) throw new Error('usage: claude-tasks.mjs <email> <plan.json>');
const plan = JSON.parse(readFileSync(planFile, 'utf8'));
const sql = neon(process.env.DATABASE_URL);
const uid = p => p + randomBytes(4).toString('hex').slice(0, 6);
const iso = d => d.toISOString().slice(0, 10);

const [u] = await sql`SELECT id FROM users WHERE lower(email) = ${email.toLowerCase()}`;
if (!u) throw new Error(`no account for ${email}`);
const stamp = async () => (await sql`SELECT COALESCE(max(updated_at)::text, '') AS s, count(*)::int AS n FROM workspace_parts WHERE user_id = ${u.id}`)[0];
const before = await stamp();
if (!before.n) throw new Error('workspace is empty or not migrated yet. Open the app once, then retry.');
const rows = await sql`SELECT part, doc FROM workspace_parts WHERE user_id = ${u.id}`;
const parts = Object.fromEntries(rows.map(r => [r.part, r.doc]));
const doc = fromParts(parts);

const d = doc.data;
const now = Date.now();
const me = d.me;

let p = d.projects.find(x => x.key === plan.project.key);
if (!p) {
  p = {
    id: uid('p'),
    key: plan.project.key,
    seq: 0,
    name: plan.project.name,
    desc: plan.project.desc || '',
    icon: plan.project.icon || 'folder',
    color: plan.project.color || 'indigo',
    lead: me,
    members: [me],
    team: '',
    status: 'active',
    fav: false,
    last: 0,
    start: iso(new Date()),
    due: plan.project.due || iso(new Date(now + 30 * 864e5)),
    milestones: [],
  };
  d.projects.push(p);
  d.projOrder.push(p.id);
}

const log = (verb, t) => d.activity.unshift({ id: uid('a'), by: me, verb, task: t.id, project: p.id, at: now, extra: '' });
let added = 0,
  updated = 0;
for (const spec of plan.tasks) {
  let t = d.tasks.find(x => x.project === p.id && x.title === spec.title);
  if (t) {
    if (spec.status && spec.status !== t.status) {
      t.status = spec.status;
      t.updated = now;
      log(spec.status === 'done' ? 'completed' : 'moved', t);
      updated++;
    }
    continue;
  }
  p.seq += 1;
  t = {
    id: uid('t'),
    key: `${p.key}-${p.seq}`,
    title: spec.title,
    desc: spec.desc ? `<p>${spec.desc}</p>` : '',
    status: spec.status || 'todo',
    priority: spec.priority || 'medium',
    project: p.id,
    assignee: me,
    due: spec.due || null,
    start: iso(new Date()),
    estimate: null,
    labels: spec.labels || [],
    deps: [],
    subtasks: [],
    attachments: [],
    fav: false,
    recur: null,
    order: d.tasks.filter(x => x.project === p.id).length + 1,
    created: now,
    updated: now,
  };
  d.tasks.push(t);
  log('created', t);
  added++;
}

// refuse to write if the app saved in the meantime (small race window, fine for a helper script)
const after = await stamp();
if (after.s !== before.s) throw new Error('workspace changed while editing (app open and saved). Run again.');
const next = toParts(doc);
const changed = Object.entries(next).filter(([n, v]) => JSON.stringify(v) !== JSON.stringify(parts[n]));
await sql.transaction(
  changed.map(
    ([n, v]) => sql`INSERT INTO workspace_parts (user_id, part, doc, bytes, updated_at)
      VALUES (${u.id}, ${n}, ${JSON.stringify(v)}::jsonb, ${JSON.stringify(v).length}, now())
      ON CONFLICT (user_id, part) DO UPDATE SET doc = EXCLUDED.doc, bytes = EXCLUDED.bytes, updated_at = now()`,
  ),
);
await sql`DELETE FROM workspace_parts WHERE user_id = ${u.id} AND NOT (part = ANY(${Object.keys(next)}))`;
console.log(`${p.key}: ${added} added, ${updated} updated (${changed.length} parts written)`);
