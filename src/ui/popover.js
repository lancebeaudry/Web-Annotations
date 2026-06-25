import { insertComment, updateComment, deleteComment } from '../data.js';
import { h, toast } from './overlay.js';
import { savedName } from './auth.js';
import { attachMentions, mentionLabel } from './mentions.js';
import { deviceLabel } from '../capture.js';

function fmtDate(iso) {
  return (iso || '').slice(0, 10);
}

function authorLabel(app, comment) {
  const name = comment.author_name || comment.author_email;
  const isTeam = comment.author_email.toLowerCase().endsWith(`@${app.teamDomain}`);
  return `${name} (${isTeam ? 'Avalanche' : 'client'})`;
}

function replies(app, rootId) {
  return [...app.comments.values()]
    .filter((c) => c.parent_id === rootId)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
}

function clampLeft(x, width) {
  const max = window.scrollX + document.documentElement.clientWidth - width - 12;
  return Math.max(window.scrollX + 12, Math.min(x, max));
}

export function closePopovers(app) {
  app.ui.layer.querySelectorAll('.popover, .mention-menu').forEach((el) => el.remove());
  app.openThreadId = null;
}

// Thread popover: original pinned comment + replies + reply box,
// with resolve/reopen for the Avalanche team.
export function openThread(app, rootId) {
  closePopovers(app);
  const root = app.comments.get(rootId);
  if (!root) return;
  app.openThreadId = rootId;

  const thread = h('div', { class: 'thread' });
  const renderEntries = () => {
    thread.replaceChildren(
      entry(app, root),
      ...replies(app, rootId).map((r) => entry(app, r))
    );
    thread.scrollTop = thread.scrollHeight;
  };

  const replyInput = h('textarea', { placeholder: 'Reply… (type @ to notify someone)', rows: '2' });
  const replyMentions = attachMentions(app, replyInput, app.ui.layer);
  const replyBtn = h('button', { class: 'btn', type: 'submit' }, 'Reply');
  const replyForm = h('form', {}, h('div', { class: 'field' }, replyInput), h('div', { class: 'btn-row' }, replyBtn));

  replyForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = replyInput.value.trim();
    if (!text) return;
    replyBtn.disabled = true;
    const row = await insertComment(app.supabase, {
      project_id: app.project.id,
      parent_id: rootId,
      page_url: root.page_url,
      page_path: root.page_path,
      comment_text: text,
      author_email: app.session.user.email,
      author_name: savedName() || null,
      mentions: replyMentions.getMentions(),
    });
    replyBtn.disabled = false;
    if (!row) {
      toast(app.ui, 'Reply failed — try again');
      return;
    }
    app.comments.set(row.id, row);
    replyInput.value = '';
    renderEntries();
  });

  const headBits = [h('span', {}, `Comment · <${root.element_tag || 'page'}>`)];
  if (root.status === 'resolved') headBits.push(h('span', { class: 'status-tag' }, 'Resolved'));

  const body = h('div', { class: 'card-body' });
  if (root.selector) {
    body.appendChild(h('div', { class: 'context' }, root.selector));
  }
  body.append(thread, replyForm);

  const footer = h('div', { class: 'btn-row' });

  // Delete: author of the pin or any team member; two-step confirm,
  // removes the pin and all its replies.
  const canDelete = app.isTeam || root.author_email === app.session.user.email;
  if (canDelete) {
    const deleteBtn = h('button', { class: 'btn btn-danger' }, 'Delete');
    deleteBtn.addEventListener('click', () => {
      const keepBtn = h('button', { class: 'btn btn-ghost' }, 'Keep it');
      const reallyBtn = h('button', { class: 'btn btn-danger' }, 'Yes, delete');
      const replyCount = replies(app, rootId).length;
      const note = h(
        'span',
        { class: 'confirm-note' },
        `Delete this comment${replyCount ? ` + ${replyCount} repl${replyCount === 1 ? 'y' : 'ies'}` : ''}?`
      );
      footer.replaceChildren(note, keepBtn, reallyBtn);
      keepBtn.addEventListener('click', () => openThread(app, rootId));
      reallyBtn.addEventListener('click', async () => {
        reallyBtn.disabled = true;
        const ok = await deleteComment(app.supabase, rootId);
        if (!ok) {
          toast(app.ui, 'Delete failed');
          openThread(app, rootId);
          return;
        }
        for (const r of replies(app, rootId)) app.comments.delete(r.id);
        app.comments.delete(rootId);
        closePopovers(app);
        app.refresh();
        toast(app.ui, 'Comment deleted');
      });
    });
    footer.appendChild(deleteBtn);
  }

  if (app.isTeam) {
    const resolveBtn = h(
      'button',
      { class: `btn ${root.status === 'open' ? 'btn-teal' : 'btn-ghost'}` },
      root.status === 'open' ? 'Mark resolved' : 'Reopen'
    );
    resolveBtn.addEventListener('click', async () => {
      resolveBtn.disabled = true;
      const next = root.status === 'open' ? 'resolved' : 'open';
      const row = await updateComment(app.supabase, rootId, { status: next });
      resolveBtn.disabled = false;
      if (!row) {
        toast(app.ui, 'Update failed');
        return;
      }
      app.comments.set(row.id, row);
      app.refresh();
      openThread(app, rootId);
    });
    footer.appendChild(resolveBtn);
  }

  if (footer.children.length) body.appendChild(footer);

  const pop = h(
    'div',
    { class: 'card popover' },
    h(
      'div',
      { class: 'card-head' },
      ...headBits,
      h('button', { class: 'close', onclick: () => closePopovers(app) }, '✕')
    ),
    body
  );

  // Anchor next to the pin (falls back to viewport center)
  const pinEl = [...app.ui.pinLayer.children].find(
    (el) => el.textContent === String(pinNumber(app, rootId))
  );
  const x = pinEl ? parseFloat(pinEl.style.left) + 18 : window.scrollX + innerWidth / 2 - 160;
  const y = pinEl ? parseFloat(pinEl.style.top) + 4 : window.scrollY + innerHeight / 3;
  pop.style.left = `${clampLeft(x, 320)}px`;
  pop.style.top = `${y}px`;

  app.ui.layer.appendChild(pop);
  renderEntries();
}

function pinNumber(app, rootId) {
  const pins = [...app.comments.values()]
    .filter((c) => !c.parent_id && c.page_path === app.pagePath)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  return pins.findIndex((c) => c.id === rootId) + 1;
}

function entry(app, comment) {
  const meta = h('div', { class: 'meta' }, h('b', {}, authorLabel(app, comment)), ` · ${fmtDate(comment.created_at)}`);
  const device = deviceLabel(comment.viewport_w);
  if (device) meta.append(h('span', { class: 'device-pill' }, device));

  const parts = [
    meta,
    h('div', { class: 'text' }, comment.comment_text),
  ];
  if (comment.mentions && comment.mentions.length) {
    const names = comment.mentions.map((e) => mentionLabel(app, e)).join(', ');
    parts.push(h('div', { class: 'mention-tag' }, `@ ${names}`));
  }
  return h('div', { class: 'entry' }, ...parts);
}

// Refresh an open popover when realtime delivers a reply/status change.
export function refreshOpenThread(app) {
  if (app.openThreadId && app.comments.has(app.openThreadId)) {
    openThread(app, app.openThreadId);
  }
}
