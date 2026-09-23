import { locateElement, looksAddressed } from '../capture.js';
import { h } from './overlay.js';
import { openThread } from './popover.js';

// Top-level pins for the current page, in creation order (their index
// is the pin number shown to users and in the export).
export function pagePins(app) {
  return [...app.comments.values()]
    .filter((c) => !c.parent_id && c.page_path === app.pagePath)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
}

// Resolution cache: locating an element scores every same-tag element on
// the page, which is too much work to repeat on every scroll/resize tick.
// Cache per comment and reuse while the element is still attached; a DOM
// mutation (see watchLayout in app.js) clears the cache so the next
// render re-resolves against the new page.
const located = new Map(); // comment.id -> { el, confidence }
export function invalidatePins() {
  located.clear();
}

function locate(comment) {
  const hit = located.get(comment.id);
  if (hit && hit.el.isConnected) return hit;
  const fresh = locateElement(comment);
  if (fresh) located.set(comment.id, fresh);
  else located.delete(comment.id);
  return fresh;
}

// Position pins against the *live* element (selector -> fingerprint
// match), so they survive responsive reflow. Unresolvable pins are
// skipped — they still appear in the sidebar and exports.
export function pinPosition(comment) {
  const hit = locate(comment);
  if (!hit) return null;
  const rect = hit.el.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  return {
    x: rect.left + window.scrollX + (rect.width * (Number(comment.x_pct) || 50)) / 100,
    y: rect.top + window.scrollY + (rect.height * (Number(comment.y_pct) || 50)) / 100,
    confidence: hit.confidence,
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
    const weak = pos.confidence === 'weak';
    let title = comment.comment_text;
    if (addressed) title += '\n\n(content here changed since this comment — looks addressed)';
    if (weak) title += '\n\n(approximate — the original element could not be found exactly)';
    const pin = h(
      'div',
      {
        class: `pin${comment.status === 'resolved' ? ' resolved' : ''}${addressed ? ' addressed' : ''}${weak ? ' weak' : ''}`,
        title,
        onclick: () => openThread(app, comment.id),
      },
      String(i + 1)
    );
    pin.style.left = `${pos.x}px`;
    pin.style.top = `${pos.y}px`;
    app.ui.pinLayer.appendChild(pin);
  });
}
