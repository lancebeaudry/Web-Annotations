import { capture } from '../capture.js';
import { insertCommentResult, updateComment } from '../data.js';
import { h, toast } from './overlay.js';
import { savedName } from './auth.js';
import { closePopovers } from './popover.js';
import { attachMentions } from './mentions.js';
import { attachImages } from './attach.js';
import { authorEmail, renderCapCard } from '../app.js';
import { captureElementScreenshot, collectContext } from '../screenshot.js';

// New-comment box, opened by clicking an element in comment mode.
// Captures the technical context invisibly; the client only sees a
// plain text box. After the comment is saved, an automatic screenshot of
// the element's neighbourhood is attached in the background (project
// setting, on by default; skipped when the free plan's image cap is hit).
export function openCommentBox(app, el, clickEvent) {
  closePopovers(app);

  const rect = el.getBoundingClientRect();
  const xPct = rect.width ? ((clickEvent.clientX - rect.left) / rect.width) * 100 : 50;
  const yPct = rect.height ? ((clickEvent.clientY - rect.top) / rect.height) * 100 : 50;

  const input = h('textarea', { placeholder: 'What should change here? Type @ to notify someone', rows: '3' });
  const mentions = attachMentions(app, input, app.ui.layer);
  const images = attachImages(app, input);
  const save = h('button', { class: 'btn', type: 'submit' }, 'Save comment');
  const cancel = h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { mentions.destroy(); box.remove(); } }, 'Cancel');

  const form = h('form', {}, h('div', { class: 'field' }, input), images.control, h('div', { class: 'btn-row' }, cancel, save));

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
    const { data: row, error } = await insertCommentResult(app.supabase, {
      project_id: app.project.id,
      parent_id: null,
      page_url: app.pageUrl,
      page_path: app.pagePath,
      ...capture(el),
      x_pct: Math.round(xPct * 100) / 100,
      y_pct: Math.round(yPct * 100) / 100,
      viewport_w: window.innerWidth,
      comment_text: text,
      author_email: authorEmail(app),
      author_name: savedName() || null,
      mentions: mentions.getMentions(),
      attachments: images.getAttachments(),
      context: collectContext(app),
    });
    if (!row) {
      save.disabled = false;
      save.textContent = 'Save comment';
      const msg = (error && error.message) || '';
      if (/COMMENT_LIMIT/.test(msg)) {
        mentions.destroy();
        box.remove();
        renderCapCard(app);
      } else if (/PAGE_APPROVED/.test(msg)) {
        toast(app.ui, 'This page has been approved — reopen it to add comments');
      } else {
        toast(app.ui, 'Could not save — try again');
      }
      return;
    }
    app.comments.set(row.id, row);
    if (app.access) app.access.comment_count = (app.access.comment_count || 0) + 1;
    mentions.destroy();
    box.remove();
    app.refresh();
    toast(app.ui, 'Comment saved');

    // Background: automatic screenshot of the area around the element.
    const a = app.access || {};
    const capOk = a.image_limit == null || (a.image_count || 0) < a.image_limit;
    if (a.auto_screenshot !== false && capOk) {
      captureElementScreenshot(app, el).then(async (shot) => {
        if (!shot) return;
        const current = app.comments.get(row.id) || row;
        const updated = await updateComment(app.supabase, row.id, { attachments: [...(current.attachments || []), shot] });
        if (updated) {
          app.comments.set(updated.id, updated);
          if (app.access) app.access.image_count = (app.access.image_count || 0) + 1;
        }
      });
    }
  });

  const x = clickEvent.clientX + window.scrollX + 10;
  const y = clickEvent.clientY + window.scrollY + 10;
  const maxX = window.scrollX + document.documentElement.clientWidth - 332;
  box.style.left = `${Math.max(window.scrollX + 12, Math.min(x, maxX))}px`;
  box.style.top = `${y}px`;

  app.ui.layer.appendChild(box);
  input.focus();
}
