/* ---------- workspace <-> parts: pure, no browser or store dependencies ---------- */
/* Parts: "root" (prefs, views, collapsed), "d.meta" (non-list data) and "d.<key>:<n>" chunks of each
   list (tasks, comments...). Chunks are size-bounded so every part stays small. */
export const CHUNK_BYTES = 400 * 1024;

export function toParts({ data, prefs, views, collapsed }) {
  const parts = { root: { prefs, views, collapsed } };
  const meta = {};
  for (const [key, val] of Object.entries(data)) {
    if (!Array.isArray(val)) {
      meta[key] = val;
      continue;
    }
    let chunk = [];
    let size = 0;
    let n = 0;
    for (const item of val) {
      const sz = JSON.stringify(item).length;
      if (chunk.length && size + sz > CHUNK_BYTES) {
        parts[`d.${key}:${String(n++).padStart(5, '0')}`] = chunk;
        chunk = [];
        size = 0;
      }
      chunk.push(item);
      size += sz;
    }
    parts[`d.${key}:${String(n).padStart(5, '0')}`] = chunk; // also written when empty so the key survives
  }
  parts['d.meta'] = meta;
  return parts;
}

export function fromParts(parts) {
  const root = parts.root || {};
  const data = { ...(parts['d.meta'] || {}) };
  const lists = {};
  for (const name of Object.keys(parts).sort()) {
    const m = /^d\.(.+):(\d+)$/.exec(name);
    if (m) (lists[m[1]] ||= []).push(...parts[name]);
  }
  Object.assign(data, lists);
  return { data, prefs: root.prefs, views: root.views, collapsed: root.collapsed };
}
