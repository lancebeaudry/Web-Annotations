// Auto-capture of technical context when a client pins an element.

const STYLE_KEYS = [
  'fontSize', 'fontWeight', 'color', 'backgroundColor',
  'textAlign', 'display', 'width', 'padding', 'margin',
];

const GENERATED_ID = /\d{4,}|^(ember|react|radix|headlessui|aria|tippy|__)/i;

function usableId(id) {
  return !!id && /^[A-Za-z][\w-]*$/.test(id) && !GENERATED_ID.test(id);
}

function esc(value) {
  return window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/([^\w-])/g, '\\$1');
}

function segment(node) {
  const tag = node.tagName.toLowerCase();
  const parent = node.parentElement;
  if (!parent) return tag;
  const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
  if (sameTag.length === 1) return tag;
  return `${tag}:nth-of-type(${sameTag.indexOf(node) + 1})`;
}

// Build a stable, ideally-unique CSS selector: prefer a real #id,
// else a tag/nth-of-type path anchored at the nearest id ancestor,
// shortened to the fewest trailing segments that stay unique.
export function buildSelector(el) {
  if (usableId(el.id)) return `#${esc(el.id)}`;

  const parts = [];
  let anchor = '';
  let node = el;
  while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
    if (usableId(node.id)) {
      anchor = `#${esc(node.id)}`;
      break;
    }
    parts.unshift(segment(node));
    node = node.parentElement;
  }

  for (let i = parts.length - 1; i >= 0; i--) {
    const tail = parts.slice(i).join(' > ');
    const sel = anchor ? `${anchor} ${tail}` : tail;
    try {
      const matches = document.querySelectorAll(sel);
      if (matches.length === 1 && matches[0] === el) return sel;
    } catch {
      /* invalid selector — keep widening */
    }
  }

  const full = anchor ? `${anchor} > ${parts.join(' > ')}` : `body > ${parts.join(' > ')}`;
  return full;
}

// Nearest stable landmark for human orientation + re-resolution:
// an id'd ancestor, else the closest preceding heading.
export function closestLandmark(el) {
  let node = el.parentElement;
  while (node && node !== document.body) {
    if (usableId(node.id)) return `#${node.id}`;
    node = node.parentElement;
  }
  let best = null;
  for (const h of document.querySelectorAll('h1, h2, h3')) {
    if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) best = h;
  }
  if (best) {
    const text = (best.textContent || '').trim().slice(0, 60);
    return `${best.tagName.toLowerCase()} "${text}"`;
  }
  return null;
}

export function pickStyles(computed) {
  const out = {};
  for (const key of STYLE_KEYS) out[key] = computed[key];
  return out;
}

export function capture(el) {
  return {
    selector: buildSelector(el),
    selector_fallback: {
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').trim().slice(0, 120),
      nearbyLandmark: closestLandmark(el),
    },
    element_tag: el.tagName.toLowerCase(),
    current_text: (el.textContent || '').trim().slice(0, 300),
    computed_styles: pickStyles(getComputedStyle(el)),
  };
}

function normText(s) {
  return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Heuristic "looks addressed": has the content this open comment points
// at changed since it was written? Re-resolve via the stable SELECTOR
// only (the text fallback would be circular) and compare normalized text
// to what was captured. Used purely to flag the comment for the team to
// confirm — it never auto-resolves. Style-only changes aren't detected.
export function looksAddressed(comment) {
  if (comment.status !== 'open' || !comment.selector || !comment.current_text) return false;
  let el;
  try {
    el = document.querySelector(comment.selector);
  } catch {
    return false;
  }
  if (!el) return false;
  const now = (el.textContent || '').trim().slice(0, 300);
  return normText(now) !== normText(comment.current_text);
}

// Resolve a stored comment back to its live element. Selector first;
// if the site changed under us, fall back to tag + text matching.
export function resolveElement(comment) {
  if (comment.selector) {
    try {
      const el = document.querySelector(comment.selector);
      if (el) return el;
    } catch {
      /* selector no longer valid */
    }
  }
  const fb = comment.selector_fallback;
  if (fb && fb.tag && fb.text) {
    for (const el of document.querySelectorAll(fb.tag)) {
      const text = (el.textContent || '').trim();
      if (text && (text.startsWith(fb.text) || fb.text.startsWith(text.slice(0, 120)))) {
        return el;
      }
    }
  }
  return null;
}
