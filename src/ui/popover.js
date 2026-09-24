import { insertComment, updateComment, deleteComment } from '../data.js';
import { h, toast } from './overlay.js';
import { savedName } from './auth.js';
import { attachMentions, mentionLabel } from './mentions.js';
import { attachImages } from './attach.js';
import { authorEmail } from '../app.js';
import { roleLabel, authorName } from '../roles.js';
import { deviceLabel } from '../capture.js';
import { STATUS_ORDER, statusLabel, isOpenStatus } from '../status.js';
import { contextSummary } from '../screenshot.js';

function fmtDate(iso) {
  return (iso || '').slice(0, 10);
}

// "Name (role)" — the role is stamped on the row by the database at insert.
function authorLabel(app, comment) {
  return `${authorName(comment)} (${roleLabel(comment)})`;
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
  const replyImages = attachImages(app, replyInput);
  const replyBtn = h('button', { class: 'btn', type: 'submit' }, 'Reply');
  const replyForm = h('form', {}, h('div', { class: 'field' }, replyInput), replyImages.control, h('div', { class: 'btn-row' }, replyBtn));

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
      author_email: authorEmail(app),
      author_name: savedName() || null,
      mentions: replyMentions.getMentions(),
      attachments: replyImages.getAttachments(),
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
  if (root.status && root.status !== 'open') headBits.push(h('span', { class: `status-tag st-${root.status}` }, statusLabel(root.status)));
  if (root.assignee_email) headBits.push(h('span', { class: 'status-tag' }, `→ ${root.assignee_email.split('@')[0]}`));

  const body = h('div', { class: 'card-body' });
  if (root.selector) {
    body.appendChild(h('div', { class: 'context' }, root.selector));
  }
  // Browser + console context captured when the comment was made.
  const ctxText = contextSummary(root.context);
  if (ctxText) {
    const errs = (root.context.errors || []).slice(0, 8);
    const det = h('details', { class: 'context-box' }, h('summary', {}, `Details: ${ctxText}`));
    det.appendChild(h('div', {}, root.context.url || ''));
    if (errs.length) det.appendChild(h('ul', {}, ...errs.map((e) => h('li', {}, `${e.kind}: ${e.msg}`))));
    body.appendChild(det);
  }
  body.append(thread, replyForm);

  const footer = h('div', { class: 'btn-row' });

  // Delete: the author, the project owner, or staff; two-step confirm,
  // removes the pin and all its replies. (Deleting stays allowed on a
  // frozen project so authors can still trim their own data.)
  const canDelete = app.canManage || root.author_email === authorEmail(app);
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
        const ok = await deleteComment(app.supabase, rootId, root.attachments);
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

  // Status: the owner/staff, or whoever the item is assigned to.
  const me = (authorEmail(app) || '').toLowerCase();
  const canStatus = app.writable && (app.canManage || (root.assignee_email && root.assignee_email.toLowerCase() === me));
  if (canStatus) {
    const sel = h('select', { class: 'status-select', title: 'Status' }, ...STATUS_ORDER.map((s) => h('option', { value: s }, statusLabel(s))));
    sel.value = root.status || 'open';
    sel.addEventListener('change', async () => {
      sel.disabled = true;
      const row = await updateComment(app.supabase, rootId, { status: sel.value });
      sel.disabled = false;
      if (!row) return toast(app.ui, 'Update failed');
      app.comments.set(row.id, row);
      app.refresh();
      openThread(app, rootId);
    });
    footer.appendChild(sel);
    if (isOpenStatus(root.status)) {
      const done = h('button', { class: 'btn btn-teal' }, 'Mark resolved');
      done.addEventListener('click', async () => {
        done.disabled = true;
        const row = await updateComment(app.supabase, rootId, { status: 'resolved' });
        if (!row) { done.disabled = false; return toast(app.ui, 'Update failed'); }
        app.comments.set(row.id, row);
        app.refresh();
        openThread(app, rootId);
      });
      footer.appendChild(done);
    }
  }
  // Assignee: owner/staff only, from the owner + collaborators.
  if (app.canManage && app.writable && app.assignees) {
    const asel = h('select', { class: 'assignee-select', title: 'Assign to' }, h('option', { value: '' }, 'Unassigned'),
      ...app.assignees.map((e) => h('option', { value: e }, e)));
    if (root.assignee_email && !app.assignees.includes(root.assignee_email)) asel.appendChild(h('option', { value: root.assignee_email }, root.assignee_email));
    asel.value = root.assignee_email || '';
    asel.addEventListener('change', async () => {
      asel.disabled = true;
      const row = await updateComment(app.supabase, rootId, { assignee_email: asel.value || null });
      asel.disabled = false;
      if (!row) return toast(app.ui, 'Update failed');
      app.comments.set(row.id, row);
      app.refresh();
      openThread(app, rootId);
    });
    footer.appendChild(asel);
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
  if (comment.attachments && comment.attachments.length) {
    const media = h('div', { class: 'entry-media' });
    for (const a of comment.attachments) {
      const img = h('img', { class: 'entry-thumb', src: a.url, alt: a.name || 'attachment', title: 'Open full size' });
      img.addEventListener('click', () => window.open(a.url, '_blank', 'noopener'));
      media.appendChild(img);
    }
    parts.push(media);
  }
  return h('div', { class: 'entry' }, ...parts);
}

// Refresh an open popover when realtime delivers a reply/status change.
export function refreshOpenThread(app) {
  if (app.openThreadId && app.comments.has(app.openThreadId)) {
    openThread(app, app.openThreadId);
  }
}
