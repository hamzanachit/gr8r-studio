/* ---------- server: session auth + workspace sync (Neon Postgres via /api) ---------- */
import { DEFAULT_PREFS, S, STORE_KEY, _saveT, syncHooks } from './store.js';
import { emptyWorkspace } from '../data/seed.js';
import { fromParts, toParts } from './parts.js';

const WS_API = '/api/workspace';
const AUTH_API = '/api/auth';
let ready = false; // true once the workspace is loaded; pushes wait for it
let pushT;

/** Set when /api is unreachable (plain `vite dev`): app runs on localStorage with no accounts. */
export const mode = { local: false, user: null };

/* A workspace is synced as small parts: "root" (prefs, views, ui flag), "d.meta" (non-list data) and
   "d.<key>:<n>" chunks of each list (tasks, comments...). Only changed parts are sent, so there is no
   account-size ceiling and requests stay well under Vercel's 4.5 MB body limit. */
const BATCH_BYTES = 3 * 1024 * 1024;
const lastSent = new Map(); // part name -> JSON last confirmed by the server

async function api(url, opts = {}) {
  const r = await fetch(url, {
    credentials: 'same-origin',
    ...opts,
    headers: { Accept: 'application/json', ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...opts.headers },
  });
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('application/json')) throw new Error('api-unavailable');
  return { status: r.status, ok: r.ok, json: await r.json() };
}

let pushing = false;
let dirty = false;

async function push() {
  if (pushing) {
    dirty = true; // another save is mid-flight: run again once it finishes
    return;
  }
  pushing = true;
  try {
    do {
      dirty = false;
      const parts = toParts({ data: S.data, prefs: S.prefs, views: S.views, collapsed: S.ui.collapsed });
      const json = {};
      const changed = [];
      for (const [name, val] of Object.entries(parts)) {
        json[name] = JSON.stringify(val);
        if (lastSent.get(name) !== json[name]) changed.push(name);
      }
      const names = Object.keys(parts);
      const stale = [...lastSent.keys()].some(n => !(n in parts));
      // group changed parts into requests that fit the body limit; the last one carries the full part list
      const batches = [];
      let cur = [];
      let size = 0;
      for (const name of changed) {
        if (cur.length && size + json[name].length > BATCH_BYTES) {
          batches.push(cur);
          cur = [];
          size = 0;
        }
        cur.push(name);
        size += json[name].length;
      }
      if (cur.length || stale || !lastSent.size) batches.push(cur);
      for (let b = 0; b < batches.length; b++) {
        const body = { parts: Object.fromEntries(batches[b].map(n => [n, parts[n]])) };
        if (b === batches.length - 1) body.names = names;
        const r = await api(WS_API, { method: 'PUT', body: JSON.stringify(body) });
        if (r.status === 401) return expireSession();
        if (!r.ok) {
          S.ui.offline = true;
          return;
        }
        for (const n of batches[b]) lastSent.set(n, json[n]);
      }
      for (const n of [...lastSent.keys()]) if (!(n in parts)) lastSent.delete(n);
      S.ui.offline = false;
    } while (dirty);
  } catch {
    S.ui.offline = true; // keep working from localStorage
  } finally {
    pushing = false;
  }
}

function expireSession() {
  lastSent.clear();
  mode.user = null;
  ready = false;
  S.ui.auth = 'login';
  S.ui.errors = { email: 'Your session expired. Sign in again.' };
  import('../shell/render.js').then(m => m.render());
}

syncHooks.push = () => {
  if (!ready || mode.local) return;
  clearTimeout(pushT);
  pushT = setTimeout(push, 800);
};

function applyDoc(doc) {
  S.data = doc.data;
  S.prefs = Object.assign({}, DEFAULT_PREFS, doc.prefs || {});
  S.views = doc.views || {};
  S.ui.collapsed = !!doc.collapsed;
}

/** Give a brand-new account its own empty workspace: no demo content. */
function freshWorkspace(user) {
  S.data = emptyWorkspace(user);
  S.views = {};
  S.prefs = Object.assign({}, DEFAULT_PREFS, { name: user.name, title: '' });
}

async function loadWorkspace(user) {
  const parts = {};
  let after = '';
  let legacy = null;
  for (;;) {
    const r = await api(`${WS_API}?after=${encodeURIComponent(after)}`);
    if (r.status === 401) throw new Error('unauthorized');
    if (!r.ok) throw new Error('load failed');
    Object.assign(parts, r.json.parts);
    legacy = legacy || r.json.legacy || null;
    if (!r.json.next) break;
    after = r.json.next;
  }
  lastSent.clear();
  if (Object.keys(parts).length) {
    applyDoc(fromParts(parts));
    for (const [n, v] of Object.entries(parts)) lastSent.set(n, JSON.stringify(v));
    ready = true;
  } else {
    if (legacy?.data?.tasks)
      applyDoc(legacy); // account saved before parts existed: migrate on first push
    else freshWorkspace(user);
    ready = true;
    await push();
  }
}

function clearLocalCache() {
  clearTimeout(_saveT);
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* storage blocked */
  }
}

/** Boot: resolve the session. Returns 'app' (signed in or local mode) or 'login'. */
export async function bootstrap() {
  try {
    const { json } = await api(AUTH_API);
    if (!json.user) {
      clearLocalCache();
      return 'login';
    }
    mode.user = json.user;
    await loadWorkspace(json.user);
    return 'app';
  } catch {
    mode.local = true; // no backend reachable: keep the original local-only behaviour
    return 'app';
  }
}

/** POST login/signup. Resolves {ok:true} or {ok:false, error, field}. */
export async function authenticate(action, body) {
  let r;
  try {
    r = await api(`${AUTH_API}?action=${action}`, { method: 'POST', body: JSON.stringify(body) });
  } catch {
    return { ok: false, error: 'Cannot reach the server. Check your connection and try again.' };
  }
  if (!r.ok) return { ok: false, error: r.json.error || 'Something went wrong', field: r.json.field };
  mode.user = r.json.user;
  mode.local = false;
  clearLocalCache();
  try {
    if (action === 'signup') {
      freshWorkspace(r.json.user);
      lastSent.clear();
      ready = true;
      await push();
    } else {
      await loadWorkspace(r.json.user);
    }
  } catch {
    return { ok: false, error: 'Signed in, but your workspace could not be loaded. Try again.' };
  }
  return { ok: true, user: r.json.user };
}

export async function signOutServer() {
  clearTimeout(pushT);
  if (ready && !mode.local) await push(); // flush pending edits before the session ends
  try {
    await api(`${AUTH_API}?action=logout`, { method: 'POST', body: '{}' });
  } catch {
    /* already signed out or offline */
  }
  mode.user = null;
  ready = false;
  lastSent.clear();
  clearLocalCache();
  S.data = emptyWorkspace({ name: '', email: '' });
  S.views = {};
  S.prefs = Object.assign({}, DEFAULT_PREFS);
}
