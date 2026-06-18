import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY, TEAM_DOMAIN } from './config.js';
import { fetchProject, fetchComments, subscribeRealtime, isInvited } from './data.js';
import { mountOverlay, toast, h } from './ui/overlay.js';
import { renderAuthCard, removeAuthCard } from './ui/auth.js';
import { renderPins } from './ui/pins.js';
import { openCommentBox } from './ui/commentBox.js';
import { closePopovers, refreshOpenThread } from './ui/popover.js';
import { toggleSidebar, refreshSidebar, openRootCount } from './ui/sidebar.js';
import { toggleInviteMenu } from './ui/invite.js';
import { prefetchMentionables } from './ui/mentions.js';
import { buildMarkdown, buildJson, copyToClipboard } from './export.js';

function normalizePath(pathname) {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

export async function init(token) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.warn('[markup] Supabase config missing — rebuild with .env populated.');
    return;
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  const app = {
    token,
    supabase,
    teamDomain: TEAM_DOMAIN.toLowerCase(),
    project: null,
    session: null,
    isTeam: false,
    started: false,
    commentMode: false,
    comments: new Map(),
    pagePath: normalizePath(location.pathname),
    pageUrl: location.origin + normalizePath(location.pathname),
    openThreadId: null,
    ui: mountOverlay(),
    refresh: null,
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

  const { data } = await supabase.auth.getSession();
  if (data.session && !app.started) {
    app.session = data.session;
    start(app);
  } else if (!data.session) {
    // Already logged into WordPress? Sign them in automatically via the
    // plugin bridge before falling back to the email code form.
    const bridged = await tryWordPressSession(app);
    if (!bridged) renderAuthCard(app);
  }
}

// If the visitor is logged into WordPress, the plugin's /session route
// returns a freshly minted Supabase session. Set it and onAuthStateChange
// starts the app. Logged out / no plugin / any error -> false, and the
// caller shows the email code form instead.
async function tryWordPressSession(app) {
  try {
    const res = await fetch(`${location.origin}/wp-json/avalanche-markup/v1/session`, {
      credentials: 'same-origin',
      cache: 'no-store',
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

async function start(app) {
  app.started = true;
  removeAuthCard(app);

  const email = app.session.user.email.toLowerCase();
  app.isTeam = email.endsWith(`@${app.teamDomain}`);

  // Access gate: team domain is always allowed; everyone else must be
  // on the invite list. Export stays team-only regardless.
  app.allowed = app.isTeam || (await isInvited(app.supabase, email));
  if (!app.allowed) {
    renderBlockedCard(app, email);
    return;
  }

  app.project = await fetchProject(app.supabase, app.token);
  if (!app.project) {
    toast(app.ui, 'Markup: unknown project token');
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
    if (k === 'c') setCommentMode(app, true);
    else if (k === 'b') setCommentMode(app, false);
  });

  toast(app.ui, `Feedback mode ready — ${app.project.name}`);
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
  setCommentMode(app, false);
  if (el && el !== document.body && el !== document.documentElement) {
    openCommentBox(app, el, e);
  }
}

function setCommentMode(app, on) {
  if (app.commentMode === on) return;
  app.commentMode = on;
  app.modeBtn.classList.toggle('active', on);
  app.modeBtnLabel.textContent = on ? 'Click an element…' : 'Comment';
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
  app.modeBtnLabel = h('span', {}, 'Comment');
  app.modeBtn = h(
    'button',
    { class: 'fab', onclick: () => setCommentMode(app, !app.commentMode) },
    svgIcon(PEN_ICON),
    app.modeBtnLabel
  );

  const n = openRootCount(app);
  app.sidebarBtn = h(
    'button',
    { class: 'fab fab-secondary', onclick: () => toggleSidebar(app) },
    n ? `Comments (${n})` : 'Comments'
  );

  const brand = h(
    'div',
    { class: 'toolbar-brand' },
    h('span', { class: 'dot' }),
    'Avalanche Markup'
  );
  const hint = h(
    'span',
    { class: 'toolbar-hint' },
    h('kbd', {}, 'C'),
    ' comment · ',
    h('kbd', {}, 'B'),
    ' browse'
  );

  const toolbar = h('div', { class: 'toolbar' }, brand, app.modeBtn, app.sidebarBtn, hint);

  if (app.isTeam) {
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

  const exitBtn = h(
    'button',
    { class: 'fab fab-secondary spacer', title: 'End feedback session', onclick: () => confirmExit(app) },
    '✕'
  );
  toolbar.appendChild(exitBtn);

  app.ui.layer.appendChild(toolbar);

  // Push the page content up by the bar height so the bar sits beneath
  // the site rather than on top of it.
  document.body.style.paddingBottom = '52px';
}

// Signed in, but not on the invite list and not on the team domain.
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
      h('p', {}, `You're signed in as ${email}, but this address hasn't been invited yet.`),
      h('p', { class: 'hint' }, 'Ask your Avalanche contact to add your email, then reload this page.'),
      h('div', { class: 'btn-row' }, signOut)
    )
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
