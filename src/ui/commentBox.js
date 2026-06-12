import { capture } from '../capture.js';
import { insertComment } from '../data.js';
import { h, toast } from './overlay.js';
import { savedName } from './auth.js';
import { closePopovers } from './popover.js';

// New-comment box, opened by clicking an element in comment mode.
// Captures the technical context invisibly; the client only sees a
// plain text box.
export function openCommentBox(app, el, clickEvent) {
  closePopovers(app);

  const rect = el.getBoundingClientRect();
  const xPct = rect.width ? ((clickEvent.clientX - rect.left) / rect.width) * 100 : 50;
  const yPct = rect.height ? ((clickEvent.clientY - rect.top) / rect.height) * 100 : 50;

  const input = h('textarea', { placeholder: 'What should change here?', rows: '3' });
  const save = h('button', { class: 'btn', type: 'submit' }, 'Save comment');
  const cancel = h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => box.remove() }, 'Cancel');

  const form = h('form', {}, h('div', { class: 'field' }, input), h('div', { class: 'btn-row' }, cancel, save));

  const box = h(
    'div',
    { class: 'card popover' },
    h('div', { class: 'card-head' }, `New comment · <${el.tagName.toLowerCase()}>`),
    h('div', { class: 'card-body' }, form)
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    save.disabled = true;
    save.textContent = 'Saving…';
    const row = await insertComment(app.supabase, {
      project_id: app.project.id,
      parent_id: null,
      page_url: app.pageUrl,
      page_path: app.pagePath,
      ...capture(el),
      x_pct: Math.round(xPct * 100) / 100,
      y_pct: Math.round(yPct * 100) / 100,
      viewport_w: window.innerWidth,
      comment_text: text,
      author_email: app.session.user.email,
      author_name: savedName() || null,
    });
    if (!row) {
      save.disabled = false;
      save.textContent = 'Save comment';
      toast(app.ui, 'Could not save — try again');
      return;
    }
    app.comments.set(row.id, row);
    box.remove();
    app.refresh();
    toast(app.ui, 'Comment saved');
  });

  const x = clickEvent.clientX + window.scrollX + 10;
  const y = clickEvent.clientY + window.scrollY + 10;
  const maxX = window.scrollX + document.documentElement.clientWidth - 332;
  box.style.left = `${Math.max(window.scrollX + 12, Math.min(x, maxX))}px`;
  box.style.top = `${y}px`;

  app.ui.layer.appendChild(box);
  input.focus();
}
