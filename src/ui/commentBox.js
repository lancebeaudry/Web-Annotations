import { capture } from '../capture.js';
import { insertCommentResult, updateComment } from '../data.js';
import { h, toast, makeDraggable } from './overlay.js';
import { savedName } from './auth.js';
import { closePopovers } from './popover.js';
import { attachMentions } from './mentions.js';
import { attachImages, imageOnlyText } from './attach.js';
import { authorEmail, renderCapCard } from '../app.js';
import { captureElementScreenshot, collectContext } from '../screenshot.js';
import { designOn, stylePanel, attachFlag, designCall } from './design.js';

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

  const ref = app.pendingRef ? app.comments.get(app.pendingRef) : null;
  const input = h('textarea', { placeholder: 'What should change here? Type @ to notify someone', rows: '3' });
  if (ref) input.value = ref.comment_text || '';
  const mentions = attachMentions(app, input, app.ui.layer);
  const images = attachImages(app, input);
  const save = h('button', { class: 'btn', type: 'submit' }, ref ? 'Attach here' : 'Save comment');
  const cancel = h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { mentions.destroy(); box.remove(); app.pendingRef = null; } }, 'Cancel');

  const form = h('form', {}, h('div', { class: 'field' }, input), images.control, h('div', { class: 'btn-row' }, cancel, save));

  const box = h(
    'div',
    { class: 'card popover' },
    h('div', { class: 'card-head' }, `${ref ? 'Attach reference' : 'New comment'} · <${el.tagName.toLowerCase()}>`, h('span', { class: 'drag-hint' }, 'drag to move')),
    h('div', { class: 'card-body' },
      ref && ref.source ? h('div', { class: 'ref-preview' }, ref.source.screenshot ? h('img', { src: ref.source.screenshot, alt: '' }) : null, h('span', {}, `From ${ref.source.host || 'another site'} — this will become a pin on the element you clicked.`)) : null,
      form)
  );

  // Save a new root comment. Shared by the plain comment form and the
  // Style change panel. Resolves to the saved row, or null (with a toast).
  async function insertRoot(text, atts, mentionList) {
    const { data: row, error } = await insertCommentResult(app.supabase, {
      project_id: app.project.id,
      parent_id: null,
      page_url: app.pageUrl,
      page_path: app.pagePath,
      preview_id: app.previewId || null,
      ...capture(el),
      x_pct: Math.round(xPct * 100) / 100,
      y_pct: Math.round(yPct * 100) / 100,
      viewport_w: window.innerWidth,
      comment_text: text || imageOnlyText(atts.length),
      author_email: authorEmail(app),
      author_name: savedName() || null,
      mentions: mentionList,
      attachments: atts,
      context: collectContext(app),
    });
    if (!row) {
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
      return null;
    }
    app.comments.set(row.id, row);
    if (app.access) app.access.comment_count = (app.access.comment_count || 0) + 1;
    mentions.destroy();
    box.remove();
    app.refresh();

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
    return row;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (images.isUploading()) return toast(app.ui, 'Image still uploading — one moment');
    const atts = images.getAttachments();
    if (!text && !atts.length) return toast(app.ui, 'Type a comment or attach an image');
    save.disabled = true;
    save.textContent = 'Saving…';
    if (ref) {
      const updated = await updateComment(app.supabase, ref.id, {
        ...capture(el),
        page_url: app.pageUrl, page_path: app.pagePath, preview_id: app.previewId || null,
        x_pct: Math.round(xPct * 100) / 100, y_pct: Math.round(yPct * 100) / 100,
        viewport_w: window.innerWidth,
        comment_text: text || ref.comment_text,
        attachments: [...(ref.attachments || []), ...atts],
      });
      app.pendingRef = null;
      if (!updated) { save.disabled = false; save.textContent = 'Attach here'; return toast(app.ui, 'Could not attach — try again'); }
      app.comments.set(updated.id, updated);
      mentions.destroy();
      box.remove();
      if (app.setCommentMode) app.setCommentMode(false);
      app.refresh();
      toast(app.ui, 'Reference attached');
      return;
    }
    const flagged = flag && flag.flagged();
    const row = await insertRoot(text, atts, mentions.getMentions());
    if (!row) { save.disabled = false; save.textContent = 'Save comment'; return; }
    toast(app.ui, flagged ? 'Comment saved and flagged: it goes against the design system' : 'Comment saved');
    // Keep the flag on the comment so the team sees it too. The server
    // re-checks it with the same rules before recording it.
    if (flagged) {
      designCall(app, { action: 'flag', comment_id: row.id, request: flagged.request, direction: flagged.direction })
        .then((res) => { if (res && res.comment) { app.comments.set(res.comment.id, res.comment); app.refresh(); } })
        .catch(() => {});
    }
  });

  // Design rules on: "Comment | Style change", plus an instant flag under
  // the comment box when what's typed reads as a style request.
  let flag = null;
  if (!ref && designOn(app) && app.writable) {
    let panel = null;
    const tabC = h('button', { type: 'button', class: 'mode-tab on' }, 'Comment');
    const tabS = h('button', { type: 'button', class: 'mode-tab' }, 'Style change');
    const setMode = (style, prefill = null) => {
      tabC.classList.toggle('on', !style);
      tabS.classList.toggle('on', style);
      form.style.display = style ? 'none' : '';
      if (style && prefill && panel) { panel.node.remove(); panel = null; }
      if (style && !panel) {
        panel = stylePanel(app, el, (text) => insertRoot(text, [], []), prefill);
        form.after(panel.node);
      }
      if (panel) panel.node.style.display = style ? '' : 'none';
      (style ? panel.focus : () => input.focus())();
    };
    tabC.addEventListener('click', () => setMode(false));
    tabS.addEventListener('click', () => setMode(true));
    form.before(h('div', { class: 'mode-tabs' }, tabC, tabS));
    flag = attachFlag(app, el, input, (prefill) => setMode(true, prefill));
    input.closest('.field').after(flag.node);
  }

  const x = clickEvent.clientX + window.scrollX + 10;
  const y = clickEvent.clientY + window.scrollY + 10;
  const maxX = window.scrollX + document.documentElement.clientWidth - 332;
  box.style.left = `${Math.max(window.scrollX + 12, Math.min(x, maxX))}px`;
  box.style.top = `${y}px`;

  makeDraggable(box, box.querySelector('.card-head'));
  app.ui.layer.appendChild(box);
  input.focus();
}
