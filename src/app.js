import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY, DASHBOARD_URL } from './config.js';
import { fetchProject, fetchComments, subscribeRealtime, fetchAccess, createProject } from './data.js';
import { mountOverlay, toast, h } from './ui/overlay.js';
import { renderAuthCard, renderGuestCard, removeAuthCard, savedName } from './ui/auth.js';
import { renderPins } from './ui/pins.js';
import { openCommentBox } from './ui/commentBox.js';
import { closePopovers, refreshOpenThread } from './ui/popover.js';
import { toggleSidebar, closeSidebar, refreshSidebar, openRootCount, resumeJumpAfterNav } from './ui/sidebar.js';
import { toggleInviteMenu } from './ui/invite.js';
import { prefetchMentionables } from './ui/mentions.js';
import { buildMarkdown, buildJson, copyToClipboard } from './export.js';
import { brandLink, poweredBy } from './ui/brand.js';

// True when the overlay is running inside the device-preview iframe (a
// same-origin copy of the page). In that context we hide the device
// toggle (no nesting) and the exit button, but keep full commenting.
const IN_FRAME = window.self !== window.top;

function normalizePath(pathname) {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

// "Show resolved" preference, remembered across reloads (default: on).
function readShowResolved() {
  try {
    return localStorage.getItem('markup_show_resolved') !== '0';
  } catch {
    return true;
  }
}

export async function init(token, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.warn('[markup] Supabase config missing — rebuild with .env populated.');
    return;
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  const app = {
    token,
    supabase,
    project: null,
    session: null,
    // Resolved server-side by my_project_role(): operator | owner |
    // collaborator | guest | none, plus whether the project accepts writes
    // (an owner over their plan limit has newer projects frozen read-only).
    role: 'none',
    writable: false,
    canManage: false,
    // "Open feedback" is on for this site (plugin data-open): visitors can
    // comment as a guest with just a name. RLS enforces the same flag
    // server-side via projects.open_access.
    openAccess: !!options.openAccess,
    isGuest: false,
    started: false,
    commentMode: false,
    comments: new Map(),
    pagePath: normalizePath(location.pathname),
    pageUrl: location.origin + normalizePath(location.pathname),
    openThreadId: null,
    ui: mountOverlay(),
    refresh: null,
    // Persisted so resolved pins/comments stay hidden across reloads once
    // the user unticks "Show resolved". Read by both the sidebar and pins.
    sidebarFilters: { q: '', sort: 'latest', showResolved: readShowResolved() },
  };
  app.refresh = () => {
    renderPins(app);
    refreshSidebar(app);
    if (app.sidebarBtn) {
      const n = openRootCount(app);
      app.sidebarBtn.textContent = n ? `Comments (${n})` : 'Comments';
    }
  };

  // Magic-link redirects land back here with tokens in the URL hash;
  // detectSessionInUrl (default on) turns that into a session, which
  // arrives via onAuthStateChange.
  supabase.auth.onAuthStateChange((_event, session) => {
    if (session && !app.started) {
      app.session = session;
      start(app);
    }
  });

  // Set by the toolbar's "Sign in" button before it signs a guest out, so
  // the reload lands on the email form instead of the guest name card.
  let forceEmail = false;
  try {
    forceEmail = sessionStorage.getItem('markup_force_email') === '1';
    if (forceEmail) sessionStorage.removeItem('markup_force_email');
  } catch {
    /* storage blocked — just show the normal card */
  }

  const { data } = await supabase.auth.getSession();
  if (data.session && !app.started) {
    // A saved guest session must never trap a WordPress editor/admin in
    // guest mode (no Export/Resolve). If the bridge is available, silently
    // upgrade them to their real identity.
    if (data.session.user.is_anonymous && window.__avmkWp) {
      const upgraded = await tryWordPressSession(app);
      if (upgraded) return; // onAuthStateChange starts with the real session
    }
    app.session = data.session;
    start(app);
  } else if (!data.session) {
    // Already logged into WordPress? Sign them in automatically via the
    // plugin bridge. Otherwise, on an open-feedback site, ask only for a
    // display name; everywhere else fall back to the email code form.
    const bridged = await tryWordPressSession(app);
    if (!bridged) {
      if (app.openAccess && !forceEmail) renderGuestCard(app);
      else renderAuthCard(app);
    }
  }
}

// Leave guest mode: drop the anonymous session and come back on the email
// sign-in form, so an account holder (owner, collaborator or staff) gets
// their real role — Invite/Export/Resolve for owners and staff.
export async function signInAsTeam(app) {
  try {
    sessionStorage.setItem('markup_force_email', '1');
  } catch {
    /* storage blocked — they'll get the guest card and can use its link */
  }
  await app.supabase.auth.signOut();
  location.reload();
}

// A guest's stable identity. Anonymous sessions carry no email, so we use
// a synthetic id pinned to their uid — it satisfies author_email's NOT
// NULL, never matches the team-domain check, and is exactly what the
// insert/update/delete policies compare against.
export function authorEmail(app) {
  return app.isGuest ? `guest:${app.session.user.id}` : app.session.user.email;
}

// If the visitor is logged into WordPress, the plugin's /session route
// returns a freshly minted Supabase session. Set it and onAuthStateChange
// starts the app. Logged out / no plugin / any error -> false, and the
// caller shows the email code form instead.
async function tryWordPressSession(app) {
  try {
    // The plugin injects window.__avmkWp (nonce + endpoint) only for
    // logged-in users. WordPress REST cookie auth needs the nonce, so
    // without it the request reads as logged-out. No global => not logged
    // in (or bridge not enabled) => skip straight to the code form.
    const wp = window.__avmkWp;
    if (!wp || !wp.nonce) return false;
    const url = wp.rest || `${location.origin}/wp-json/avalanche-markup/v1/session`;
    const res = await fetch(url, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'X-WP-Nonce': wp.nonce },
    });
    if (!res.ok) return false;
    const d = await res.json();
    if (!d.bridge || !d.access_token || !d.refresh_token) return false;
    const { error } = await app.supabase.auth.setSession({
      access_token: d.access_token,
      refresh_token: d.refresh_token,
    });
    return !error; // onAuthStateChange fires start() on success
  } catch {
    return false;
  }
}

// Read the project, tolerating the brief window after sign-in where the
// new session hasn't propagated to PostgREST yet (anon reads are blocked
// by RLS). Retries a few times before giving up on the token.
async function fetchProjectSettled(app) {
  let project = await fetchProject(app.supabase, app.token);
  for (let i = 0; !project && i < 4; i++) {
    await new Promise((r) => setTimeout(r, 200));
    project = await fetchProject(app.supabase, app.token);
  }
  return project;
}

// Create the project row for a site being opened for the first time, OWNED
// by the signed-in account (the DB forces owner = caller and enforces the
// plan limit). The display name is taken from the page title (trimmed to
// the part before a " – Tagline" separator); open_access mirrors the
// plugin's data-open flag. If the insert loses a race with someone else's
// first visit (unique token), re-read the row they created.
async function registerProject(app) {
  const titled = (document.title || '').split(/[|–—-]/)[0].trim();
  const name = (titled || app.token).slice(0, 120);
  const { data: created, error } = await createProject(app.supabase, {
    token: app.token,
    name,
    site_url: location.origin,
    open_access: app.openAccess,
  });
  if (created) {
    toast(app.ui, `Markup: registered “${created.name}”`);
    return created;
  }
  if (error && /PROJECT_LIMIT/.test(error.message || '')) {
    app._limitReached = true;
    return null;
  }
  return await fetchProjectSettled(app);
}

async function start(app) {
  app.started = true;
  removeAuthCard(app);

  // Anonymous (guest) sessions have NO email, so this must stay guarded.
  app.isGuest = !!app.session.user.is_anonymous;
  const email = (app.session.user.email || '').toLowerCase();

  // First authed read. On the code-verification path the just-attached
  // session can lag the first request by a tick; retry briefly before
  // trusting an empty result.
  app.project = await fetchProjectSettled(app);
  if (!app.project && !app.isGuest) {
    // First visit to an unregistered site by a signed-in account: register
    // it, owned by them. The database enforces their plan's project limit.
    app.project = await registerProject(app);
  }
  if (!app.project) {
    if (app._limitReached) renderLimitCard(app);
    else if (!app.isGuest) toast(app.ui, 'Markup: couldn’t register this site — try again');
    else renderUnregisteredCard(app); // a guest can't register; offer sign-in
    return;
  }

  // Role + write access, decided server-side in one call. Open-feedback is
  // folded in there too (a guest or unlocked visitor on an open project
  // comes back as role 'guest'), so there is no client-side gate to drift.
  const access = await fetchAccess(app.supabase, app.project.id);
  app.role = access.role;
  app.writable = access.writable;
  app.canManage = app.role === 'operator' || app.role === 'owner';
  app.allowed = app.role !== 'none';
  if (!app.allowed) {
    renderBlockedCard(app, email || 'this guest session');
    return;
  }

  // Fetch the whole project's comments (export covers all pages);
  // pins only render for the current page_path.
  for (const row of await fetchComments(app.supabase, app.project.id)) {
    app.comments.set(row.id, row);
  }

  prefetchMentionables(app); // warm the @-mention roster (fire-and-forget)

  renderToolbar(app);
  renderPins(app);

  subscribeRealtime(app.supabase, app.project.id, (type, row) => {
    if (!row || !row.id) return;
    if (type === 'DELETE') app.comments.delete(row.id);
    else app.comments.set(row.id, row);
    renderPins(app);
    refreshOpenThread(app);
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => renderPins(app), 150);
  });
  // Late layout shifts (fonts, images) move elements under the pins.
  window.addEventListener('load', () => renderPins(app));

  // Keyboard shortcuts: C = comment mode, B = browse mode. Ignored
  // while typing in any field (including the shadow-DOM comment box).
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.composedPath()[0];
    const tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
    const k = e.key.toLowerCase();
    if (k === 'c' && app.writable) setCommentMode(app, true);
    else if (k === 'b') setCommentMode(app, false);
  });

  toast(app.ui, `Feedback mode ready — ${app.project.name}`);

  // If we got here from a cross-page comment click, reopen the sidebar
  // and jump to that comment. (Top page only — not the preview frame.)
  if (!IN_FRAME) resumeJumpAfterNav(app);
}

/* ---------------- comment mode ---------------- */

function onMouseMove(app, e) {
  if (e.composedPath().includes(app.ui.host)) {
    app.ui.highlight.style.display = 'none';
    return;
  }
  const el = e.target;
  if (!el || el === document.body || el === document.documentElement) {
    app.ui.highlight.style.display = 'none';
    return;
  }
  const rect = el.getBoundingClientRect();
  const hl = app.ui.highlight;
  hl.style.display = 'block';
  hl.style.left = `${rect.left + window.scrollX}px`;
  hl.style.top = `${rect.top + window.scrollY}px`;
  hl.style.width = `${rect.width}px`;
  hl.style.height = `${rect.height}px`;
}

function onClickCapture(app, e) {
  if (e.composedPath().includes(app.ui.host)) return;
  e.preventDefault();
  e.stopPropagation();
  const el = e.target;
  // Stay in comment mode — each click drops another pin. The user leaves
  // by pressing B or clicking the Browse button. openCommentBox closes any
  // box still open before opening the new one.
  if (el && el !== document.body && el !== document.documentElement) {
    openCommentBox(app, el, e);
  }
}

function updateModeButtons(app) {
  if (app.modeBtn) app.modeBtn.classList.toggle('active', app.commentMode);
  if (app.browseBtn) app.browseBtn.classList.toggle('active', !app.commentMode);
}

function setCommentMode(app, on) {
  if (app.commentMode === on) {
    updateModeButtons(app);
    return;
  }
  app.commentMode = on;
  updateModeButtons(app);
  document.documentElement.style.cursor = on ? 'crosshair' : '';
  if (on) {
    closePopovers(app);
    app._move = (e) => onMouseMove(app, e);
    app._click = (e) => onClickCapture(app, e);
    document.addEventListener('mousemove', app._move, true);
    document.addEventListener('click', app._click, true);
  } else {
    document.removeEventListener('mousemove', app._move, true);
    document.removeEventListener('click', app._click, true);
    app.ui.highlight.style.display = 'none';
  }
}

/* ---------------- toolbar + export ---------------- */

const PEN_ICON =
  'M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z';
const CURSOR_ICON = 'M3 3l7.07 17 2.51-7.39L20 10.07 3 3z';
const DESKTOP_ICON = 'M3 5h18v11H3zM8 20h8M12 16v4';
const TABLET_ICON = 'M6 3h12v18H6zM11 18h2';
const MOBILE_ICON = 'M8 2h8v20H8zM11 18h2';

// Device-preview widths. 'desktop' = no frame (the live page).
const DEVICE_WIDTHS = { tablet: 768, mobile: 390 };

// A small segmented control (desktop / tablet / mobile). Reflects the
// current app.device; rendered in the toolbar.
function makeDeviceControl(app) {
  const btn = (device, icon, title) =>
    h('button', {
      class: `dev-btn${app.device === device ? ' active' : ''}`,
      title,
      'data-device': device,
      onclick: () => setDevice(app, device),
    }, svgIcon(icon));
  return h('div', { class: 'device-toggle' },
    btn('desktop', DESKTOP_ICON, 'Desktop'),
    btn('tablet', TABLET_ICON, 'Tablet'),
    btn('mobile', MOBILE_ICON, 'Mobile'));
}

// Switch the preview size. Tablet/mobile render the page inside a
// device-width iframe (a same-origin copy with ?markup, so the overlay
// runs inside it and you can comment at that size). Desktop tears it down.
function setDevice(app, device) {
  app.device = device;
  app.ui.layer.querySelectorAll('.dev-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.device === device));

  if (device === 'desktop') {
    if (app.deviceStage) { app.deviceStage.remove(); app.deviceStage = null; }
    if (app.toolbarEl) app.toolbarEl.style.display = '';
    return;
  }

  const width = DEVICE_WIDTHS[device] || 390;
  if (app.deviceStage) {
    // Already framed — just resize, no iframe reload.
    const frame = app.deviceStage.querySelector('.device-frame');
    if (frame) frame.style.width = `${width}px`;
    const label = app.deviceStage.querySelector('.device-label');
    if (label) label.textContent = `${device} · ${width}px`;
    return;
  }

  // Enter device mode: clear page-level UI, hide the main toolbar, and
  // mount the framed copy with its own floating device switcher.
  setCommentMode(app, false);
  closeSidebar(app);
  closePopovers(app);
  if (app.toolbarEl) app.toolbarEl.style.display = 'none';

  const iframe = h('iframe', { class: 'device-frame', src: location.href });
  iframe.style.width = `${width}px`;
  const bar = h('div', { class: 'device-bar' },
    makeDeviceControl(app),
    h('span', { class: 'device-label' }, `${device} · ${width}px`));
  const stage = h('div', { class: 'device-stage' }, bar, iframe);
  app.deviceStage = stage;
  app.ui.layer.appendChild(stage);
}

function svgIcon(d) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

function renderToolbar(app) {
  // Comment and Browse are explicit, sticky modes — you stay in the one
  // you pick until you switch (button or C / B shortcut).
  app.modeBtn = h(
    'button',
    { class: 'fab', title: 'Comment mode (C)', onclick: () => setCommentMode(app, true) },
    svgIcon(PEN_ICON),
    h('span', { class: 'fab-label' }, 'Comment')
  );
  app.browseBtn = h(
    'button',
    { class: 'fab fab-secondary', title: 'Browse mode (B)', onclick: () => setCommentMode(app, false) },
    svgIcon(CURSOR_ICON),
    h('span', { class: 'fab-label' }, 'Browse')
  );

  const n = openRootCount(app);
  app.sidebarBtn = h(
    'button',
    { class: 'fab fab-secondary', onclick: () => toggleSidebar(app) },
    n ? `Comments (${n})` : 'Comments'
  );

  const brand = brandLink('toolbar');
  const hint = h(
    'span',
    { class: 'toolbar-hint' },
    h('kbd', {}, 'C'),
    ' comment · ',
    h('kbd', {}, 'B'),
    ' browse'
  );

  // Guests see who they're commenting as, so it's obvious the name is
  // attached to their feedback (and that they're not signed in as staff).
  const who = app.isGuest
    ? h('span', { class: 'toolbar-who' }, `${savedName() || 'Guest'} · guest`)
    : null;

  // A frozen project (owner over their plan limit) is read-only: no Comment
  // button, and a strip that says why.
  const toolbar = app.writable
    ? h('div', { class: 'toolbar' }, brand, app.modeBtn, app.browseBtn, app.sidebarBtn)
    : h(
        'div',
        { class: 'toolbar' },
        brand,
        app.browseBtn,
        app.sidebarBtn,
        h('span', { class: 'readonly-strip' }, 'Read-only — the owner’s plan no longer covers this project')
      );
  // Device-preview toggle — not inside the framed copy (no nesting).
  app.device = app.device || 'desktop';
  if (!IN_FRAME) toolbar.appendChild(makeDeviceControl(app));
  toolbar.appendChild(hint);
  if (who) toolbar.appendChild(who);
  // Flexible gap pushes the management buttons (Invite/Export/Exit) to
  // the far right of the bar.
  toolbar.appendChild(h('div', { class: 'toolbar-spacer' }));

  // Escape hatch out of guest mode. Without this a guest session is a
  // dead end — it persists in the browser, so a team member who entered
  // by name could never reach Export/Resolve.
  if (app.isGuest) {
    const signInBtn = h(
      'button',
      {
        class: 'fab fab-secondary',
        title: 'Have an account? Sign in with your email to get your full role',
        onclick: () => signInAsTeam(app),
      },
      'Sign in'
    );
    toolbar.appendChild(signInBtn);
  }

  if (app.canManage) {
    const inviteBtn = h(
      'button',
      { class: 'fab fab-secondary', onclick: () => toggleInviteMenu(app) },
      'Invite'
    );
    const exportBtn = h(
      'button',
      { class: 'fab fab-secondary', onclick: () => toggleExportMenu(app) },
      'Export'
    );
    toolbar.append(inviteBtn, exportBtn);
  }

  // Exit ends the whole session — only meaningful on the top page, not
  // inside the device-preview frame.
  if (!IN_FRAME) {
    const exitBtn = h(
      'button',
      { class: 'fab fab-secondary', title: 'End feedback session', onclick: () => confirmExit(app) },
      '✕'
    );
    toolbar.appendChild(exitBtn);
  }

  app.toolbarEl = toolbar;
  app.ui.layer.appendChild(toolbar);
  updateModeButtons(app); // reflect the current mode on the buttons

  // Push the page content up by the bar height so the bar sits beneath
  // the site rather than on top of it.
  document.body.style.paddingBottom = '52px';
}

// The site has no project row yet and this visitor can't create one (a
// guest). Most often an owner landed on their brand-new open-feedback site
// and got routed into the guest name card first — so offer sign-in (which
// drops the guest session) and a path to create an account.
function renderUnregisteredCard(app) {
  const signInBtn = h('button', { class: 'btn' }, 'I own this site — sign in');
  const create = h(
    'a',
    {
      class: 'btn btn-ghost',
      href: `${DASHBOARD_URL}#/projects/new?site=${encodeURIComponent(location.origin)}&token=${encodeURIComponent(app.token)}`,
      target: '_blank',
      rel: 'noopener',
    },
    'Create a free account'
  );
  const card = h(
    'div',
    { class: 'card auth-card' },
    h('div', { class: 'card-head' }, 'Site not set up yet'),
    h(
      'div',
      { class: 'card-body' },
      h('p', {}, 'This site hasn’t been registered with Markup. The site owner needs to open it once while signed in.'),
      h('p', { class: 'hint' }, 'If you’re a reviewer, ask whoever sent you this link — nothing to do on your end.'),
      h('div', { class: 'btn-row' }, create, signInBtn)
    ),
    poweredBy('card')
  );
  signInBtn.addEventListener('click', () => signInAsTeam(app));
  app.ui.layer.appendChild(card);
}

// Signed in and tried to register this site, but the account's plan is at
// its project limit. Upgrade lives in the dashboard.
function renderLimitCard(app) {
  const upgrade = h(
    'a',
    { class: 'btn', href: `${DASHBOARD_URL}#/account`, target: '_blank', rel: 'noopener' },
    'Upgrade in the dashboard'
  );
  const card = h(
    'div',
    { class: 'card auth-card' },
    h('div', { class: 'card-head' }, 'Project limit reached'),
    h(
      'div',
      { class: 'card-body' },
      h('p', {}, 'Your plan’s project limit is used up, so this site couldn’t be registered.'),
      h('p', { class: 'hint' }, 'The free plan includes one project. Upgrade to add more sites — then reload this page.'),
      h('div', { class: 'btn-row' }, upgrade)
    ),
    poweredBy('card')
  );
  app.ui.layer.appendChild(card);
}

// Show a friendly dead-end with a way to sign out and try another email.
function renderBlockedCard(app, email) {
  const signOut = h('button', { class: 'btn btn-ghost' }, 'Use a different email');
  const card = h(
    'div',
    { class: 'card auth-card' },
    h('div', { class: 'card-head' }, 'Access needed'),
    h(
      'div',
      { class: 'card-body' },
      h('p', {}, `You're signed in as ${email}, but this address hasn't been invited to this project yet.`),
      h('p', { class: 'hint' }, 'Ask the project owner to add your email, then reload this page.'),
      h('p', { class: 'hint' }, h('a', { href: DASHBOARD_URL, target: '_blank', rel: 'noopener' }, 'Have an account? Open the dashboard')),
      h('div', { class: 'btn-row' }, signOut)
    ),
    poweredBy('card')
  );
  signOut.addEventListener('click', async () => {
    await app.supabase.auth.signOut();
    location.reload();
  });
  app.ui.layer.appendChild(card);
}

// Ending the session forgets the token and reloads without ?markup so
// the page comes back as a normal visit — confirmed first.
function confirmExit(app) {
  const existing = app.ui.layer.querySelector('.confirm-card');
  if (existing) {
    existing.remove();
    return;
  }
  const stay = h('button', { class: 'btn btn-ghost' }, 'Keep going');
  const end = h('button', { class: 'btn' }, 'End session');
  const card = h(
    'div',
    { class: 'card confirm-card' },
    h('div', { class: 'card-head' }, 'End feedback session?'),
    h(
      'div',
      { class: 'card-body' },
      h('p', {}, 'Your comments are saved. The page will reload as a normal visit — use your feedback link to come back.'),
      h('div', { class: 'btn-row' }, stay, end)
    )
  );
  stay.addEventListener('click', () => card.remove());
  end.addEventListener('click', () => {
    try {
      sessionStorage.removeItem('markup_token');
    } catch {
      /* nothing stored */
    }
    const url = new URL(location.href);
    url.searchParams.delete('markup');
    location.href = url.toString();
  });
  app.ui.layer.appendChild(card);
}

function toggleExportMenu(app) {
  const existing = app.ui.layer.querySelector('.export-menu');
  if (existing) {
    existing.remove();
    return;
  }

  const option = (title, hint, fn) =>
    h('button', { class: 'opt', onclick: async () => {
      const { text, count } = fn();
      menu.remove();
      if (!count) {
        toast(app.ui, 'No open comments to export');
        return;
      }
      const ok = await copyToClipboard(text);
      toast(app.ui, ok ? `Copied ${count} comment${count === 1 ? '' : 's'} to clipboard` : 'Copy failed');
    } }, title, h('small', {}, hint));

  const menu = h(
    'div',
    { class: 'card export-menu' },
    h('div', { class: 'card-head' }, 'Export open comments'),
    option('Markdown — this page', 'Paste into Claude Code', () => buildMarkdown(app, 'page')),
    option('Markdown — whole project', 'All pages, grouped by path', () => buildMarkdown(app, 'project')),
    option('JSON — this page', 'Raw comment objects', () => buildJson(app, 'page')),
    option('JSON — whole project', 'Raw comment objects', () => buildJson(app, 'project'))
  );

  app.ui.layer.appendChild(menu);
}
