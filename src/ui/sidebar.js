import { h, toast } from './overlay.js';
import { updateComment, deleteComment } from '../data.js';
import { resolveElement } from '../capture.js';
import { openThread, closePopovers } from './popover.js';

// Slide-out panel listing every comment in the project, grouped by
// page (current page first), with jump-to-pin, resolve, and delete.

function fmtDate(iso) {
  return (iso || '').slice(0, 10);
}

function rootsByPage(app) {
  const roots = [...app.comments.values()]
    .filter((c) => !c.parent_id)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  const groups = new Map();
  for (const c of roots) {
    if (!groups.has(c.page_path)) groups.set(c.page_path, []);
    groups.get(c.page_path).push(c);
  }
  // Current page floats to the top.
  const ordered = new Map();
  if (groups.has(app.pagePath)) ordered.set(app.pagePath, groups.get(app.pagePath));
  for (const [path, list] of groups) if (path !== app.pagePath) ordered.set(path, list);
  return ordered;
}

export function openRootCount(app) {
  return [...app.comments.values()].filter((c) => !c.parent_id && c.status === 'open').length;
}

export function toggleSidebar(app) {
  if (app.sidebarEl) {
    closeSidebar(app);
    return;
  }
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
    list
  );
  app.sidebarEl = panel;
  app.sidebarList = list;
  app.ui.layer.appendChild(panel);
  panel.getBoundingClientRect(); // commit the off-screen position so the slide-in transition runs
  panel.classList.add('open');
  app.ui.layer.classList.add('sidebar-open');
  refreshSidebar(app);
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

export function refreshSidebar(app) {
  if (!app.sidebarList) return;
  const list = app.sidebarList;
  list.replaceChildren();

  const groups = rootsByPage(app);
  if (!groups.size) {
    list.appendChild(h('div', { class: 'side-empty' }, 'No comments yet. Hit Comment and click anywhere on the page.'));
    return;
  }

  const openTotal = openRootCount(app);
  app.sidebarEl.querySelector('.side-title').textContent = `All comments (${openTotal} open)`;

  for (const [path, comments] of groups) {
    const here = path === app.pagePath;
    list.appendChild(h('div', { class: 'side-group-h' }, here ? `${path} — this page` : path));
    comments.forEach((c, i) => list.appendChild(item(app, c, i + 1, here)));
  }
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

  const el = h(
    'div',
    {
      class: `side-item${comment.status === 'resolved' ? ' resolved' : ''}`,
      onclick: () => jumpTo(app, comment, onThisPage),
    },
    h('div', { class: 'side-top' }, h('span', { class: 'side-num' }, String(number)), h('span', { class: 'side-text' }, comment.comment_text)),
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
  closeSidebar(app);
  closePopovers(app);
  const target = resolveElement(comment);
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => openThread(app, comment.id), target ? 450 : 0);
}
