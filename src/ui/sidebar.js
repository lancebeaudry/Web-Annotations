import { h, toast } from './overlay.js';
import { updateComment, deleteComment } from '../data.js';
import { resolveElement, looksAddressed, deviceOf, DEVICE_TEXT, currentDevice } from '../capture.js';
import { openThread, closePopovers } from './popover.js';
import { authorEmail } from '../app.js';
import { STATUS_ORDER, statusLabel, isOpenStatus, labelText, effortText } from '../status.js';

// Slide-out panel listing every comment in the project, grouped by
// page (current page first), with jump-to-pin, resolve, and delete.

function fmtDate(iso) {
  return (iso || '').slice(0, 10);
}

// Group root comments by page (current page first) and assign each a
// stable pin number from its CREATION order within the page, so the
// number keeps matching the pin on the page even when the list is
// re-sorted or filtered. Then apply the active search / sort / status
// filters for display.
function groupedItems(app) {
  const { q, sort, showResolved, thisPageOnly, device } = app.sidebarFilters;
  const needle = q.trim().toLowerCase();

  const roots = [...app.comments.values()]
    .filter((c) => !c.parent_id)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));

  const groups = new Map();
  for (const c of roots) {
    if (!groups.has(c.page_path)) groups.set(c.page_path, []);
    groups.get(c.page_path).push(c);
  }

  // Order the page groups by the active sort so "Latest first" actually
  // surfaces the newest comments at the very top, no matter which page
  // they live on. (Previously the current page was always pinned first,
  // which made the sort look broken when newer comments were on another
  // page.) Rank each page by its newest comment for "latest", oldest for
  // "oldest".
  const rank = (path) => {
    const times = groups.get(path).map((c) => c.created_at);
    return sort === 'latest'
      ? times.reduce((m, t) => (t > m ? t : m))
      : times.reduce((m, t) => (t < m ? t : m));
  };
  const order = [...groups.keys()].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra === rb) return 0;
    return sort === 'latest' ? (ra < rb ? 1 : -1) : (ra < rb ? -1 : 1);
  });

  const result = [];
  for (const path of order) {
    if (thisPageOnly && path !== app.pagePath) continue;
    const list = groups.get(path);
    if (!list) continue;
    let items = list.map((comment, i) => ({ comment, number: i + 1 }));

    items = items.filter(({ comment }) => {
      if (!showResolved && !isOpenStatus(comment.status)) return false;
      if (device && device !== 'all' && (deviceOf(comment.viewport_w) || 'desktop') !== device) return false;
      if (needle) {
        const hay = `${comment.comment_text} ${comment.author_name || ''} ${comment.author_email} ${comment.current_text || ''} ${comment.selector || ''}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });

    if (sort === 'latest') items.reverse(); // base order is oldest→newest
    if (items.length) result.push([path, items]);
  }
  return result;
}

export function openRootCount(app) {
  return [...app.comments.values()].filter((c) => !c.parent_id && isOpenStatus(c.status)).length;
}

export function toggleSidebar(app) {
  if (app.sidebarEl) {
    closeSidebar(app);
    return;
  }
  app.sidebarFilters = app.sidebarFilters || { q: '', sort: 'latest', showResolved: true };
  const f = app.sidebarFilters;

  const search = h('input', {
    class: 'side-search',
    type: 'search',
    placeholder: 'Search comments…',
    value: f.q,
  });
  search.addEventListener('input', () => {
    f.q = search.value;
    renderList(app);
  });

  const sortSel = h(
    'select',
    { class: 'side-select' },
    h('option', { value: 'latest' }, 'Latest first'),
    h('option', { value: 'oldest' }, 'Oldest first')
  );
  sortSel.value = f.sort;
  sortSel.addEventListener('change', () => {
    f.sort = sortSel.value;
    renderList(app);
  });

  const resolvedBox = h('input', { type: 'checkbox' });
  resolvedBox.checked = f.showResolved;
  resolvedBox.addEventListener('change', () => {
    f.showResolved = resolvedBox.checked;
    try {
      localStorage.setItem('markup_show_resolved', resolvedBox.checked ? '1' : '0');
    } catch {
      /* storage blocked — preference just won't persist */
    }
    app.refresh(); // updates both the list and the pins on the page
  });
  const resolvedLabel = h('label', { class: 'side-check' }, resolvedBox, 'Show closed');

  const thisPageBox = h('input', { type: 'checkbox' });
  thisPageBox.checked = !!f.thisPageOnly;
  thisPageBox.addEventListener('change', () => {
    f.thisPageOnly = thisPageBox.checked;
    renderList(app);
  });
  const thisPageLabel = h('label', { class: 'side-check' }, thisPageBox, 'This page only');

  // Device the comment was left on. Old rows without a width count as desktop.
  const deviceSel = h('select', { class: 'side-select', title: 'Device the comment was left on' },
    h('option', { value: 'all' }, 'All devices'), h('option', { value: 'desktop' }, 'Desktop'), h('option', { value: 'tablet' }, 'Tablet'), h('option', { value: 'mobile' }, 'Mobile'));
  deviceSel.value = f.device || 'all';
  deviceSel.addEventListener('change', () => { f.device = deviceSel.value; renderList(app); });

  const controls = h(
    'div',
    { class: 'side-controls' },
    search,
    h('div', { class: 'side-filters' }, sortSel, deviceSel),
    h('div', { class: 'side-filters side-checks' }, resolvedLabel, thisPageLabel)
  );

  const list = h('div', { class: 'side-list' });
  const panel = h(
    'div',
    { class: 'sidebar' },
    h(
      'div',
      { class: 'card-head' },
      h('span', { class: 'side-title' }, 'All comments'),
      h('button', { class: 'close', onclick: () => closeSidebar(app) }, '✕')
    ),
    controls,
    list
  );
  app.sidebarEl = panel;
  app.sidebarList = list;
  app.ui.layer.appendChild(panel);
  panel.getBoundingClientRect(); // commit the off-screen position so the slide-in transition runs
  panel.classList.add('open');
  app.ui.layer.classList.add('sidebar-open');
  renderList(app);
}

export function closeSidebar(app) {
  const panel = app.sidebarEl;
  if (!panel) return;
  app.sidebarEl = null;
  app.sidebarList = null;
  panel.classList.remove('open');
  app.ui.layer.classList.remove('sidebar-open');
  setTimeout(() => panel.remove(), 250);
}

// Re-render just the list body (controls persist, so the search box
// keeps focus). Exported as refreshSidebar so external callers
// (app.refresh, realtime) keep working.
function renderList(app) {
  if (!app.sidebarList) return;
  const list = app.sidebarList;
  list.replaceChildren();

  const openTotal = openRootCount(app);
  app.sidebarEl.querySelector('.side-title').textContent = `All comments (${openTotal} open)`;

  const hasAny = [...app.comments.values()].some((c) => !c.parent_id);
  const groups = groupedItems(app);

  if (!groups.length) {
    list.appendChild(
      h('div', { class: 'side-empty' }, hasAny ? 'No comments match your search/filters.' : 'No comments yet. Hit Comment and click anywhere on the page.')
    );
    return;
  }

  for (const [path, items] of groups) {
    const here = path === app.pagePath;
    list.appendChild(h('div', { class: 'side-group-h' }, here ? `${path} — this page` : path));
    items.forEach(({ comment, number }) => list.appendChild(item(app, comment, number, here)));
  }
}

export function refreshSidebar(app) {
  renderList(app);
}

function item(app, comment, number, onThisPage) {
  const name = comment.author_name || comment.author_email;
  const replyCount = [...app.comments.values()].filter((r) => r.parent_id === comment.id).length;

  const actions = h('div', { class: 'side-actions' });
  actions.addEventListener('click', (e) => e.stopPropagation());

  const me = (authorEmail(app) || '').toLowerCase();
  const triageOn = !(app.access && app.access.triage && app.access.triage.status === false);
  if (triageOn && app.writable && (app.canManage || (comment.assignee_email && comment.assignee_email.toLowerCase() === me))) {
    const sel = h('select', { class: 'status-select' }, ...STATUS_ORDER.map((s) => h('option', { value: s }, statusLabel(s))));
    sel.value = comment.status || 'open';
    sel.addEventListener('change', async () => {
      sel.disabled = true;
      const row = await updateComment(app.supabase, comment.id, { status: sel.value });
      if (!row) {
        sel.disabled = false;
        toast(app.ui, 'Update failed');
        return;
      }
      app.comments.set(row.id, row);
      app.refresh();
    });
    actions.appendChild(sel);
  }

  if (app.canManage || comment.author_email === authorEmail(app)) {
    const deleteBtn = h('button', { class: 'mini-btn danger' }, 'Delete');
    deleteBtn.addEventListener('click', () => {
      const yes = h('button', { class: 'mini-btn danger' }, 'Yes, delete');
      const no = h('button', { class: 'mini-btn' }, 'Keep');
      actions.replaceChildren(h('span', { class: 'side-confirm' }, 'Sure?'), no, yes);
      no.addEventListener('click', () => app.refresh());
      yes.addEventListener('click', async () => {
        yes.disabled = true;
        const ok = await deleteComment(app.supabase, comment.id, comment.attachments);
        if (!ok) {
          toast(app.ui, 'Delete failed');
          app.refresh();
          return;
        }
        for (const r of [...app.comments.values()]) {
          if (r.parent_id === comment.id) app.comments.delete(r.id);
        }
        app.comments.delete(comment.id);
        app.refresh();
        toast(app.ui, 'Comment deleted');
      });
    });
    actions.appendChild(deleteBtn);
  }

  const addressed = onThisPage && looksAddressed(comment);

  const metaEl = h('div', { class: 'side-meta' }, `${name} · ${fmtDate(comment.created_at)}${replyCount ? ` · ${replyCount} repl${replyCount === 1 ? 'y' : 'ies'}` : ''}${comment.assignee_email ? ` · → ${comment.assignee_email.split('@')[0]}` : ''}`);
  if (comment.status && comment.status !== 'open') metaEl.append(h('span', { class: `side-status st-${comment.status}` }, statusLabel(comment.status)));
  for (const l of comment.labels || []) metaEl.append(h('span', { class: `side-status lb-${l}` }, labelText(l)));
  if (comment.effort) metaEl.append(h('span', { class: 'side-status' }, effortText(comment.effort)));
  const dev = deviceOf(comment.viewport_w);
  if (dev) metaEl.append(h('span', { class: `device-pill dev-${dev}` }, DEVICE_TEXT[dev]));
  // On this page but left at a different width: say so, and the click
  // below switches the preview instead of scrolling to nothing.
  const here = currentDevice();
  const mismatch = onThisPage && dev && dev !== here;

  const el = h(
    'div',
    {
      class: `side-item${comment.status === 'resolved' ? ' resolved' : ''}${!isOpenStatus(comment.status) ? ' closed' : ''}${addressed ? ' addressed' : ''}`,
      onclick: () => jumpTo(app, comment, onThisPage),
    },
    h('div', { class: 'side-top' }, h('span', { class: 'side-num' }, String(number)), h('span', { class: 'side-text' }, comment.comment_text)),
    addressed ? h('div', { class: 'side-addressed' }, '✎ Content changed here — looks addressed') : null,
    mismatch ? h('div', { class: 'side-devnote' }, `Left on ${DEVICE_TEXT[dev].toLowerCase()} — click to switch to that view`) : null,
    metaEl,
    actions
  );
  return el;
}

function jumpTo(app, comment, onThisPage) {
  if (!onThisPage) {
    // Remember the target so the destination page can reopen the sidebar
    // and jump straight to this comment after it loads.
    try {
      sessionStorage.setItem('markup_jump', comment.id);
    } catch {
      /* storage blocked — navigation still works, just no auto-jump */
    }
    // Navigate by the comment's PATH against the CURRENT origin — never the
    // stored page_url's origin. Comments are matched by page_path everywhere,
    // so the same comment lives on whatever host you're viewing (local,
    // staging, production). Jumping to page_path + current origin keeps you in
    // your environment instead of bouncing you to the host the comment was
    // first created on.
    let path = comment.page_path;
    if (!path) {
      try { path = new URL(comment.page_url).pathname; } catch { path = '/'; }
    }
    const url = new URL(path, location.origin);
    if (app.token) url.searchParams.set('markup', app.token);
    location.href = url.toString();
    return;
  }
  // Left at another width? Switch the preview to that device; the framed
  // copy picks the comment up from sessionStorage when it loads.
  const dev = deviceOf(comment.viewport_w);
  if (dev && dev !== currentDevice() && app.setDevice) {
    try { sessionStorage.setItem('markup_jump', comment.id); } catch { /* fine */ }
    if (window.self !== window.top) {
      // We're the framed copy: ask the top page to switch (it owns the frame).
      window.parent.postMessage({ markupDevice: dev }, location.origin);
      return;
    }
    app.setDevice(dev);
    return;
  }
  // Keep the sidebar open — just scroll to the pin and open its thread.
  closePopovers(app);
  const target = resolveElement(comment);
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => openThread(app, comment.id), target ? 450 : 0);
}

// After a cross-page jump, reopen the sidebar and go to the clicked
// comment. Called once the overlay is ready on the destination page.
export function resumeJumpAfterNav(app) {
  let id;
  try {
    id = sessionStorage.getItem('markup_jump');
    if (id) sessionStorage.removeItem('markup_jump');
  } catch {
    return;
  }
  if (!id) return;
  const comment = app.comments.get(id);
  if (!comment || comment.page_path !== app.pagePath) return;
  // Inside a device frame the sidebar would cover the whole page, so only
  // reopen it at the top level.
  if (!app.sidebarEl && window.self === window.top) toggleSidebar(app);
  const target = resolveElement(comment);
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => openThread(app, comment.id), target ? 600 : 0);
}
