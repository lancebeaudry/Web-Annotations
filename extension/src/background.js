// PinPoint Anywhere — service worker.
//
// Holds the Supabase session (emailed code, same as the dashboard), lists
// the user's projects, takes the tab screenshot for the picker, and saves
// a reference: screenshot to Storage, then a comments row of kind
// 'reference'. Everything goes through the REST API with the user's own
// token, so row-level security decides what they can see and write.

const SUPABASE_URL = __SUPABASE_URL__;
const ANON_KEY = __SUPABASE_ANON_KEY__;
const STORE = chrome.storage.local;

const get = (k) => STORE.get(k).then((r) => r[k]);
const set = (k, v) => STORE.set({ [k]: v });

async function session() {
  const s = await get('pp_session');
  if (!s) return null;
  if (s.expires_at && s.expires_at * 1000 - Date.now() < 60_000) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST', headers: { apikey: ANON_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: s.refresh_token }),
    });
    if (!r.ok) { await STORE.remove('pp_session'); return null; }
    const n = await r.json();
    await set('pp_session', n);
    return n;
  }
  return s;
}

async function api(path, init = {}) {
  const s = await session();
  if (!s) throw new Error('Sign in from the PinPoint toolbar button first');
  const r = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${s.access_token}`, 'content-type': 'application/json', ...(init.headers || {}) },
  });
  const text = await r.text();
  let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!r.ok) throw new Error((body && (body.message || body.error_description || body.error || body.hint)) || `HTTP ${r.status}`);
  return body;
}

const dataUrlToBlob = async (d) => (await fetch(d)).blob();

async function saveReference(p, sender) {
  const s = await session();
  if (!s) throw new Error('Sign in from the PinPoint toolbar button first');
  const email = (s.user && s.user.email || '').toLowerCase();
  const name = (await get('pp_name')) || null;
  const projects = await api(`/rest/v1/projects?id=eq.${p.project_id}&select=id,name,site_url,token`);
  const project = projects[0];
  if (!project) throw new Error('That project is no longer available to you');

  // 1. screenshot → comment-media/<project>/ref-<ts>.png
  const path = `${project.id}/ref-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
  const blob = await dataUrlToBlob(p.screenshot);
  const up = await fetch(`${SUPABASE_URL}/storage/v1/object/comment-media/${path}`, {
    method: 'POST', headers: { apikey: ANON_KEY, Authorization: `Bearer ${s.access_token}`, 'content-type': 'image/png', 'x-upsert': 'false' }, body: blob,
  });
  if (!up.ok) {
    const t = await up.text();
    throw new Error(/image_limit|not allowed|violates/.test(t) ? 'This project has reached its image allowance' : `Screenshot upload failed (${up.status})`);
  }
  const shotUrl = `${SUPABASE_URL}/storage/v1/object/public/comment-media/${path}`;

  // 2. the reference row
  const row = {
    project_id: project.id, parent_id: null, kind: 'reference',
    page_url: project.site_url, page_path: '',
    comment_text: p.note, author_email: email, author_name: name,
    mentions: [], labels: p.labels || [],
    attachments: [{ url: shotUrl, name: `Reference from ${p.source.host}`, type: 'image/png', reference: true }],
    source: { ...p.source, screenshot: shotUrl, captured_at: new Date().toISOString() },
    viewport_w: p.viewport_w,
  };
  const inserted = await api('/rest/v1/comments', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
  return { id: inserted[0] && inserted[0].id, project: project.name, tab: sender && sender.tab && sender.tab.id };
}

async function startPicker(tabId) {
  const tab = tabId ? await chrome.tabs.get(tabId) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab || !/^https?:/.test(tab.url || '')) throw new Error('Open a normal web page first (Chrome pages can’t be captured)');
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['picker.js'] });
  await chrome.tabs.sendMessage(tab.id, { type: 'pp-start' });
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    switch (msg.type) {
      case 'status': {
        const s = await session();
        return { signedIn: !!s, email: s && s.user ? s.user.email : null, name: (await get('pp_name')) || '' };
      }
      case 'sendCode': {
        const r = await fetch(`${SUPABASE_URL}/auth/v1/otp`, { method: 'POST', headers: { apikey: ANON_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ email: msg.email, create_user: true }) });
        if (!r.ok) throw new Error((await r.json()).msg || 'Could not send the code');
        return { ok: true };
      }
      case 'verify': {
        let r = await fetch(`${SUPABASE_URL}/auth/v1/verify`, { method: 'POST', headers: { apikey: ANON_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'email', email: msg.email, token: msg.code }) });
        if (!r.ok) r = await fetch(`${SUPABASE_URL}/auth/v1/verify`, { method: 'POST', headers: { apikey: ANON_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'signup', email: msg.email, token: msg.code }) });
        if (!r.ok) throw new Error('That code didn’t work. Codes expire after 10 minutes.');
        const s = await r.json();
        await set('pp_session', s);
        return { ok: true, email: s.user.email };
      }
      case 'signOut': await STORE.remove('pp_session'); return { ok: true };
      case 'setName': await set('pp_name', (msg.name || '').trim().slice(0, 80)); return { ok: true };
      case 'startPicker': return startPicker(msg.tabId);
      case 'projects': {
        const list = await api('/rest/v1/projects?select=id,name,site_url&order=name.asc');
        return { projects: list, last: await get('pp_last_project'), name: (await get('pp_name')) || '' };
      }
      case 'capture': {
        const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' });
        return { dataUrl };
      }
      case 'save': {
        await set('pp_last_project', msg.payload.project_id);
        return saveReference(msg.payload, sender);
      }
      default: throw new Error(`unknown message ${msg.type}`);
    }
  })().then((r) => reply({ ok: true, ...r })).catch((e) => reply({ ok: false, error: e.message || String(e) }));
  return true; // async reply
});

chrome.commands.onCommand.addListener((cmd) => { if (cmd === 'pick') startPicker().catch(() => {}); });
