/* ---------- server: session auth + workspace sync (Neon Postgres via /api) ---------- */
import { DEFAULT_PREFS, S, STORE_KEY, _saveT, syncHooks } from './store.js';
import { emptyWorkspace } from '../data/seed.js';

const WS_API = '/api/workspace';
const AUTH_API = '/api/auth';
let ready = false; // true once the workspace is loaded; pushes wait for it
let pushT;

/** Set when /api is unreachable (plain `vite dev`): app runs on localStorage with no accounts. */
export const mode = { local: false, user: null };

const snapshot = () => ({ data: S.data, prefs: S.prefs, views: S.views, collapsed: S.ui.collapsed });

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

async function push() {
  try {
    const r = await api(WS_API, { method: 'PUT', body: JSON.stringify(snapshot()) });
    if (r.status === 401) return expireSession();
    S.ui.offline = !r.ok;
  } catch {
    S.ui.offline = true; // keep working from localStorage
  }
}

function expireSession() {
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
  const r = await api(WS_API);
  if (r.status === 401) throw new Error('unauthorized');
  if (r.json.doc?.data?.tasks) applyDoc(r.json.doc);
  else {
    freshWorkspace(user);
    ready = true;
    await push();
  }
  ready = true;
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
  clearLocalCache();
  S.data = emptyWorkspace({ name: '', email: '' });
  S.views = {};
  S.prefs = Object.assign({}, DEFAULT_PREFS);
}
