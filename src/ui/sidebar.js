import { h, toast } from './overlay.js';
import { updateComment, deleteComment } from '../data.js';
import { resolveElement, looksAddressed } from '../capture.js';
import { openThread, closePopovers } from './popover.js';

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
  const { q, sort, showResolved } = app.sidebarFilters;
  const needle = q.trim().toLowerCase();

  const roots = [...app.comments.values()]
    .filter((c) => !c.parent_id)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));

  const groups = new Map();
  for (const c of roots) {
    if (!groups.has(c.page_path)) groups.set(c.page_path, []);
    groups.get(c.page_path).push(c);
  }

  // Current page first, then the rest in encounter order.
  const order = [app.pagePath, ...[...groups.keys()].filter((p) => p !== app.pagePath)];

  const result = [];
  for (const path of order) {
    const list = groups.get(path);
    if (!list) continue;
    let items = list.map((comment, i) => ({ comment, number: i + 1 }));

    items = items.filter(({ comment }) => {
      if (!showResolved && comment.status === 'resolved') return false;
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
  return [...app.comments.values()].filter((c) => !c.parent_id && c.status === 'open').length;
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
  const resolvedLabel = h('label', { class: 'side-check' }, resolvedBox, 'Show resolved');

  const controls = h(
    'div',
    { class: 'side-controls' },
    search,
    h('div', { class: 'side-filters' }, sortSel, resolvedLabel)
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

  if (app.isTeam) {
    const resolveBtn = h(
      'button',
      { class: 'mini-btn teal' },
      comment.status === 'open' ? 'Resolve' : 'Reopen'
    );
    resolveBtn.addEventListener('click', async () => {
      resolveBtn.disabled = true;
      const row = await updateComment(app.supabase, comment.id, {
        status: comment.status === 'open' ? 'resolved' : 'open',
      });
      if (!row) {
        resolveBtn.disabled = false;
        toast(app.ui, 'Update failed');
        return;
      }
      app.comments.set(row.id, row);
      app.refresh();
    });
    actions.appendChild(resolveBtn);
  }

  if (app.isTeam || comment.author_email === app.session.user.email) {
    const deleteBtn = h('button', { class: 'mini-btn danger' }, 'Delete');
    deleteBtn.addEventListener('click', () => {
      const yes = h('button', { class: 'mini-btn danger' }, 'Yes, delete');
      const no = h('button', { class: 'mini-btn' }, 'Keep');
      actions.replaceChildren(h('span', { class: 'side-confirm' }, 'Sure?'), no, yes);
      no.addEventListener('click', () => app.refresh());
      yes.addEventListener('click', async () => {
        yes.disabled = true;
        const ok = await deleteComment(app.supabase, comment.id);
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

  const el = h(
    'div',
    {
      class: `side-item${comment.status === 'resolved' ? ' resolved' : ''}${addressed ? ' addressed' : ''}`,
      onclick: () => jumpTo(app, comment, onThisPage),
    },
    h('div', { class: 'side-top' }, h('span', { class: 'side-num' }, String(number)), h('span', { class: 'side-text' }, comment.comment_text)),
    addressed ? h('div', { class: 'side-addressed' }, '✎ Content changed here — looks addressed') : null,
    h('div', { class: 'side-meta' }, `${name} · ${fmtDate(comment.created_at)}${replyCount ? ` · ${replyCount} repl${replyCount === 1 ? 'y' : 'ies'}` : ''}`),
    actions
  );
  return el;
}

function jumpTo(app, comment, onThisPage) {
  if (!onThisPage) {
    // Session token persists across navigation, so the overlay (and
    // this comment's pin) will be live on the destination page.
    location.href = comment.page_url;
    return;
  }
  // Keep the sidebar open — just scroll to the pin and open its thread.
  closePopovers(app);
  const target = resolveElement(comment);
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => openThread(app, comment.id), target ? 450 : 0);
}
