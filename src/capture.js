// Auto-capture of technical context when a client pins an element, and
// the resolver that finds that element again later.
//
// Why this is more than querySelector: the selector we store is often a
// positional path (div:nth-of-type(2) > section > p:nth-of-type(3)). When
// the site later gains a cookie banner, an admin bar, a wrapper div or a
// reordered section, that path still MATCHES — just a different element —
// so a naive "selector first, text fallback only if nothing matched" put
// pins on the wrong thing. The fix is a fingerprint captured alongside the
// selector (text, id, stable classes, key attributes, landmark) and a
// scorer that ranks every candidate against it. The selector is one
// candidate source, never the final word.

const STYLE_KEYS = [
  'fontSize', 'fontWeight', 'color', 'backgroundColor',
  'textAlign', 'display', 'width', 'padding', 'margin',
];

const GENERATED_ID = /\d{4,}|^(ember|react|radix|headlessui|aria|tippy|__)/i;
// Class names that change between builds/states and would poison a match:
// hashed CSS-in-JS, utility-hash, and common state classes.
const GENERATED_CLASS = /^(css-|sc-|jsx-|_|is-|has-|js-|wp-block-|w-|e-con|elementor-element-[a-z0-9]{6,}$|st-|ng-|svelte-)|[0-9a-f]{6,}|\d{3,}/i;
const STATE_CLASS = /^(active|open|hover|focus|selected|visible|hidden|show|shown|loaded|loading|animated|in-view|aos-)/i;
const ATTR_KEYS = ['href', 'src', 'alt', 'aria-label', 'name', 'placeholder', 'data-testid', 'data-id', 'title', 'type'];
const MAX_CANDIDATES = 3000;

function usableId(id) {
  return !!id && /^[A-Za-z][\w-]*$/.test(id) && !GENERATED_ID.test(id);
}

function esc(value) {
  return window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/([^\w-])/g, '\\$1');
}

function stableClasses(el) {
  const out = [];
  for (const c of el.classList || []) {
    if (c.length > 40 || GENERATED_CLASS.test(c) || STATE_CLASS.test(c)) continue;
    out.push(c);
    if (out.length === 6) break;
  }
  return out;
}

function normText(s) {
  return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function ownText(el) {
  return (el.textContent || '').trim();
}

function segment(node) {
  const tag = node.tagName.toLowerCase();
  const parent = node.parentElement;
  if (!parent) return tag;
  const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
  if (sameTag.length === 1) return tag;
  return `${tag}:nth-of-type(${sameTag.indexOf(node) + 1})`;
}

function uniqueFor(sel, el) {
  try {
    const m = document.querySelectorAll(sel);
    return m.length === 1 && m[0] === el;
  } catch {
    return false;
  }
}

// Build a stable, ideally-unique CSS selector. Preference order:
//   1. a real #id on the element
//   2. tag + stable classes, if that alone is unique on the page
//   3. an id-anchored ancestor + tag/classes, if unique
//   4. the shortest unique tag/nth-of-type path (anchored at an id if any)
// Class-based forms survive wrapper insertions and reordering; the
// positional path is the last resort because it is the least stable.
export function buildSelector(el) {
  if (usableId(el.id)) return `#${esc(el.id)}`;

  const tag = el.tagName.toLowerCase();
  const classes = stableClasses(el);
  if (classes.length) {
    const byClass = `${tag}.${classes.map(esc).join('.')}`;
    if (uniqueFor(byClass, el)) return byClass;
  }

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

  if (anchor && classes.length) {
    const anchoredClass = `${anchor} ${tag}.${classes.map(esc).join('.')}`;
    if (uniqueFor(anchoredClass, el)) return anchoredClass;
  }

  for (let i = parts.length - 1; i >= 0; i--) {
    const tail = parts.slice(i).join(' > ');
    const sel = anchor ? `${anchor} ${tail}` : tail;
    if (uniqueFor(sel, el)) return sel;
  }

  return anchor ? `${anchor} > ${parts.join(' > ')}` : `body > ${parts.join(' > ')}`;
}

function idAncestor(el) {
  let node = el.parentElement;
  while (node && node !== document.body) {
    if (usableId(node.id)) return `#${node.id}`;
    node = node.parentElement;
  }
  return null;
}

function precedingHeading(el) {
  let best = null;
  for (const h of document.querySelectorAll('h1, h2, h3')) {
    if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) best = h;
    else break;
  }
  return best ? normText(ownText(best)).slice(0, 60) : null;
}

// Nearest stable landmark for human orientation + re-resolution:
// an id'd ancestor, else the closest preceding heading.
export function closestLandmark(el) {
  const id = idAncestor(el);
  if (id) return id;
  const heading = precedingHeading(el);
  if (heading) {
    let best = null;
    for (const h of document.querySelectorAll('h1, h2, h3')) {
      if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) best = h;
    }
    return `${best.tagName.toLowerCase()} "${ownText(best).slice(0, 60)}"`;
  }
  return null;
}

function attrsOf(el) {
  const out = {};
  for (const k of ATTR_KEYS) {
    const v = el.getAttribute && el.getAttribute(k);
    if (v) out[k] = String(v).slice(0, 200);
  }
  return out;
}

// Which same-tag sibling this is among those with identical text — tells
// two identical "Learn more" buttons apart.
function twinIndex(el, text) {
  const t = normText(text);
  if (!t) return 0;
  let i = 0;
  for (const other of document.querySelectorAll(el.tagName)) {
    if (other === el) return i;
    if (normText(ownText(other)) === t) i++;
  }
  return i;
}

export function pickStyles(computed) {
  const out = {};
  for (const key of STYLE_KEYS) out[key] = computed[key];
  return out;
}

export function capture(el) {
  const text = ownText(el);
  const rect = el.getBoundingClientRect();
  return {
    selector: buildSelector(el),
    selector_fallback: {
      v: 2,
      tag: el.tagName.toLowerCase(),
      text: text.slice(0, 120),
      textLen: text.length,
      id: usableId(el.id) ? el.id : null,
      classes: stableClasses(el),
      attrs: attrsOf(el),
      nearbyLandmark: closestLandmark(el),
      idAncestor: idAncestor(el),
      heading: precedingHeading(el),
      twin: twinIndex(el, text),
      parentTag: el.parentElement ? el.parentElement.tagName.toLowerCase() : null,
      size: [Math.round(rect.width), Math.round(rect.height)],
    },
    element_tag: el.tagName.toLowerCase(),
    current_text: text.slice(0, 300),
    computed_styles: pickStyles(getComputedStyle(el)),
  };
}

// Classify the viewport width a pin was placed at into a device bucket.
// Desktop is the default/baseline, so it returns null (not worth labeling);
// only tablet/mobile pins get a badge, to flag size-specific feedback.
export function deviceLabel(viewportW) {
  const w = Number(viewportW);
  if (!w) return null;
  if (w < 600) return 'Mobile';
  if (w < 1024) return 'Tablet';
  return null;
}

// Which preview a comment belongs to: 'mobile' | 'tablet' | 'desktop', or
// null for old rows that never recorded a width.
export function deviceOf(viewportW) {
  const w = Number(viewportW);
  if (!w) return null;
  if (w < 600) return 'mobile';
  if (w < 1024) return 'tablet';
  return 'desktop';
}
export const DEVICE_TEXT = { mobile: 'Mobile', tablet: 'Tablet', desktop: 'Desktop' };
export const currentDevice = () => deviceOf(window.innerWidth);

// Heuristic "looks addressed": has the content this open comment points
// at changed since it was written? Locate the element by its fingerprint
// (id, classes, attributes, landmark — the things that survive a text
// edit), then compare its text to what was captured. Falls back to the
// raw selector only when it still lands in the same neighbourhood, since
// a positional path on a reflowed page points at a different element
// entirely and would flag every pin as "addressed". Used purely to flag
// the comment for the team to confirm — it never auto-resolves.
export function looksAddressed(comment) {
  if (comment.status !== 'open' || !comment.current_text) return false;
  const fb = comment.selector_fallback || {};
  let el = null;
  const hit = locateElement(comment);
  if (hit && hit.confidence !== 'weak') el = hit.el;
  if (!el && comment.selector) {
    try {
      const cand = document.querySelector(comment.selector);
      const tagOk = cand && (!fb.tag || cand.tagName.toLowerCase() === fb.tag);
      const placeOk = cand && (fb.idAncestor ? idAncestor(cand) === fb.idAncestor : fb.heading ? precedingHeading(cand) === fb.heading : !fb.v);
      if (tagOk && placeOk) el = cand;
    } catch {
      /* selector no longer valid */
    }
  }
  if (!el) return false;
  const now = ownText(el).slice(0, 300);
  return normText(now) !== normText(comment.current_text);
}

// ---------------------------------------------------------------- resolve

function textScore(candText, fbText, fbLen) {
  const a = normText(candText);
  const b = normText(fbText);
  if (!b) return a ? -5 : 10; // text-less target: a text-less candidate is a mild plus
  if (!a) return -30;
  let s = 0;
  if (a === b) s += 50;
  else if (a.slice(0, 120) === b.slice(0, 120)) s += 45; // long text, same first 120 chars
  else if (a.startsWith(b) || b.startsWith(a)) s += 22;
  else {
    const ta = new Set(a.split(' '));
    const tb = b.split(' ');
    let hit = 0;
    for (const w of tb) if (ta.has(w)) hit++;
    s += Math.round((hit / Math.max(tb.length, 1)) * 20);
  }
  // Containers carry their children's text: a match whose text is much
  // longer than what we captured is probably an ancestor of the target.
  if (fbLen && candText.length > fbLen * 1.5 + 40) s -= Math.min(30, Math.round(((candText.length - fbLen) / Math.max(fbLen, 1)) * 5));
  return s;
}

function scoreCandidate(el, comment, viaSelector) {
  const fb = comment.selector_fallback || {};
  let s = viaSelector ? 15 : 0;
  const tag = el.tagName.toLowerCase();
  if (fb.tag) s += tag === fb.tag ? 8 : -25;

  const text = ownText(el);
  if (fb.v >= 2 || fb.text) s += textScore(text, fb.text, fb.textLen);
  else if (comment.current_text) s += textScore(text, comment.current_text.slice(0, 120), comment.current_text.length);

  if (fb.id) s += usableId(el.id) && el.id === fb.id ? 40 : 0;
  if (fb.classes && fb.classes.length) {
    const have = new Set(el.classList || []);
    let hit = 0;
    for (const c of fb.classes) if (have.has(c)) hit++;
    s += Math.round((hit / fb.classes.length) * 15);
  }
  if (fb.attrs) {
    for (const [k, v] of Object.entries(fb.attrs)) {
      const cur = el.getAttribute(k);
      if (cur == null) continue;
      if (String(cur).slice(0, 200) === v) s += k === 'href' || k === 'src' || k === 'data-testid' ? 15 : 8;
      else if (k === 'href' || k === 'src') s -= 6;
    }
  }
  if (fb.idAncestor) s += idAncestor(el) === fb.idAncestor ? 10 : -4;
  else if (fb.heading) s += precedingHeading(el) === fb.heading ? 8 : 0;
  if (fb.parentTag && el.parentElement) s += el.parentElement.tagName.toLowerCase() === fb.parentTag ? 3 : 0;

  const rect = el.getBoundingClientRect();
  if (!rect.width && !rect.height) s -= 100; // hidden / collapsed
  return s;
}

// Locate the live element for a stored comment. Returns
// { el, confidence } where confidence is 'exact' | 'likely' | 'weak',
// or null when nothing on the page resembles the target.
export function locateElement(comment) {
  const fb = comment.selector_fallback || {};
  const seen = new Set();
  const ranked = [];
  const consider = (el, viaSelector) => {
    if (!el || seen.has(el) || el.closest('#markup-root')) return;
    seen.add(el);
    ranked.push({ el, score: scoreCandidate(el, comment, viaSelector) });
  };

  if (comment.selector) {
    try {
      const m = document.querySelectorAll(comment.selector);
      for (let i = 0; i < m.length && i < 25; i++) consider(m[i], true);
    } catch {
      /* selector no longer valid */
    }
  }

  const hasFingerprint = !!(fb.text || fb.id || (fb.classes && fb.classes.length) || (fb.attrs && Object.keys(fb.attrs).length) || comment.current_text);
  const tag = fb.tag || comment.element_tag;
  // Pre-2.1 comments with a bare selector and no text: the selector is all
  // we have, so take its first match.
  if (!hasFingerprint) {
    const best = ranked[0];
    return best ? { el: best.el, confidence: 'likely' } : null;
  }

  // If the selector's own match is convincing, stop there (cheap path).
  ranked.sort((a, b) => b.score - a.score);
  const strong = fb.text ? 70 : 45;
  if (ranked.length && ranked[0].score >= strong) return { el: ranked[0].el, confidence: 'exact' };

  // Otherwise rank every element of that tag on the page.
  if (tag) {
    const all = document.querySelectorAll(tag);
    for (let i = 0; i < all.length && i < MAX_CANDIDATES; i++) consider(all[i], false);
    ranked.sort((a, b) => b.score - a.score);
  }
  if (!ranked.length) return null;

  // Identical twins (two "Learn more" buttons): pick by original ordinal.
  const top = ranked[0];
  if (fb.twin != null && fb.twin > 0 && fb.text) {
    const twins = ranked.filter((r) => r.score === top.score);
    if (twins.length > fb.twin) {
      twins.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
      return { el: twins[fb.twin].el, confidence: 'likely' };
    }
  }

  const floor = fb.text ? 30 : 18;
  if (top.score < floor) return null;
  return { el: top.el, confidence: top.score >= strong ? 'exact' : top.score >= floor + 15 ? 'likely' : 'weak' };
}

// Back-compat wrapper: the element or null.
export function resolveElement(comment) {
  const hit = locateElement(comment);
  return hit ? hit.el : null;
}
