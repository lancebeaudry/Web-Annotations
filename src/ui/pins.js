import { resolveElement, looksAddressed } from '../capture.js';
import { h } from './overlay.js';
import { openThread } from './popover.js';

// Top-level pins for the current page, in creation order (their index
// is the pin number shown to users and in the export).
export function pagePins(app) {
  return [...app.comments.values()]
    .filter((c) => !c.parent_id && c.page_path === app.pagePath)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
}

// Position pins against the *live* element (selector -> fallback text
// match), so they survive responsive reflow. Unresolvable pins are
// skipped — they still appear in exports.
export function pinPosition(comment) {
  const el = resolveElement(comment);
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  return {
    x: rect.left + window.scrollX + (rect.width * (Number(comment.x_pct) || 50)) / 100,
    y: rect.top + window.scrollY + (rect.height * (Number(comment.y_pct) || 50)) / 100,
  };
}

export function renderPins(app) {
  app.ui.pinLayer.replaceChildren();
  // Hide resolved pins unless "Show resolved" is on. Numbering still
  // follows creation order (i + 1), so visible pins keep the same number
  // as their sidebar entry even when resolved ones are skipped.
  const showResolved = app.sidebarFilters ? app.sidebarFilters.showResolved : true;
  pagePins(app).forEach((comment, i) => {
    if (!showResolved && comment.status === 'resolved') return;
    const pos = pinPosition(comment);
    if (!pos) return;
    const addressed = looksAddressed(comment);
    const pin = h(
      'div',
      {
        class: `pin${comment.status === 'resolved' ? ' resolved' : ''}${addressed ? ' addressed' : ''}`,
        title: addressed ? `${comment.comment_text}\n\n(content here changed since this comment — looks addressed)` : comment.comment_text,
        onclick: () => openThread(app, comment.id),
      },
      String(i + 1)
    );
    pin.style.left = `${pos.x}px`;
    pin.style.top = `${pos.y}px`;
    app.ui.pinLayer.appendChild(pin);
  });
}
