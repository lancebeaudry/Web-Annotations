// The design system page: every color, type size, button, surface and rule
// in a project's design system, drawn from its tokens. Members see it at
// #/projects/:id/design (plus exceptions, pending rule changes and the
// changelog); anyone with a share link sees the view-only part at
// #/design/:token.
//
// Tokens are owner-edited JSON and the share page is public, so values only
// ever reach the page through textContent and CSSOM setters (never HTML or
// style attributes), and the web-font stylesheet must come from Google Fonts
// or Adobe Fonts.
import { h, fmtDate, toast, copyBox } from '../ui/dom.js';
import { card, pageHead } from '../ui/shell.js';
import { getProject, projectAccess, designSystem, designExceptions, designProposals, designChangelog, designFn, sharedDesign } from '../api.js';
import { contrast } from '../../../supabase/functions/_shared/designEngine.ts';

const FONT_HOSTS = ['fonts.googleapis.com', 'use.typekit.net', 'p.typekit.net'];
const entries = (o) => Object.entries(o && typeof o === 'object' ? o : {});
// The database stores tokens as jsonb, which reorders keys, so scales are
// sorted by size (largest first for type, smallest first otherwise).
const px = (x) => { const m = String(val(x) || '').match(/([\d.]+)\s*(px|rem|em)?/); return m ? parseFloat(m[1]) * (m[2] === 'rem' || m[2] === 'em' ? 16 : 1) : 0; };
const bySize = (o, desc = false) => entries(o).sort((a, b) => (desc ? px(b[1]) - px(a[1]) : px(a[1]) - px(b[1])));
const val = (x) => (x && typeof x === 'object' ? x.value : x);
const lab = (k, x) => (x && typeof x === 'object' && x.label) || k;
const hexOf = (t, key) => {
  const c = t.color && t.color[key];
  const v = String(val(c) || key || '').trim();
  return /^#[0-9a-f]{3,8}$/i.test(v) ? v : '';
};
function styled(tag, styles, ...children) {
  const el = h(tag, {}, ...children);
  for (const [k, v] of Object.entries(styles)) if (v) el.style.setProperty(k, String(v));
  return el;
}
function loadFont(t) {
  const href = t.font && t.font.css;
  try {
    const u = new URL(href);
    if (u.protocol !== 'https:' || !FONT_HOSTS.includes(u.hostname)) return;
    if (document.querySelector(`link[data-ds-font="${CSS.escape(u.href)}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = u.href;
    link.dataset.dsFont = u.href;
    document.head.appendChild(link);
  } catch { /* no font css */ }
}
const family = (t) => String(val(t.font && t.font.family) || '').replace(/[;{}<>]/g, '');
function aa(fg, bg, min = 4.5) {
  const r = fg && bg ? contrast(fg, bg) : null;
  if (r == null) return null;
  const pass = r >= min;
  return h('span', { class: `ds-aa ${pass ? 'pass' : 'fail'}`, title: `Contrast ${r}:1 (AA needs ${min}:1)` }, `${r}:1 ${pass ? 'AA' : 'fails AA'}`);
}

// ------------------------------------------------------------- sections
function colors(t) {
  const grid = h('div', { class: 'ds-swatches' });
  for (const [k, c] of entries(t.color)) {
    const hex = hexOf(t, k);
    const chip = styled('div', { background: hex }, '');
    chip.className = 'ds-chip';
    grid.appendChild(h('div', { class: 'ds-swatch-card' }, chip,
      h('div', { class: 'ds-sw-name' }, lab(k, c)),
      h('div', { class: 'ds-sw-meta' }, h('code', {}, hex || '?'), ' · ', h('code', {}, k)),
      c && c.usage ? h('div', { class: 'hint' }, c.usage) : null,
      hex && hex.toLowerCase() !== '#ffffff' && hex.toLowerCase() !== '#fff' ? h('div', { class: 'ds-sw-aa' }, h('span', { class: 'hint' }, 'As text on white'), aa(hex, '#ffffff') || '', h('span', { class: 'hint' }, 'White text on it'), aa('#ffffff', hex) || '') : null));
  }
  return grid.children.length ? card('Colors', grid) : null;
}
function typeScale(t) {
  const fam = family(t);
  const rows = bySize(t.type, true).map(([k, x]) => h('div', { class: 'ds-type-row' },
    h('div', { class: 'ds-type-meta' }, h('b', {}, lab(k, x)), h('code', {}, String(val(x) || ''))),
    styled('div', { 'font-size': val(x), 'font-family': fam, 'line-height': '1.2', 'font-weight': /display|h\d|head/i.test(k) ? '700' : '400' }, 'The quick brown fox jumps over the lazy dog')));
  const famRow = fam ? h('p', {}, 'Font: ', h('b', {}, lab('', t.font && t.font.family) || fam), h('span', { class: 'hint' }, ` (${fam})`)) : null;
  return rows.length || famRow ? card('Typography', famRow, ...rows) : null;
}
function buttonEl(t, b) {
  const radius = val(t.radius && (t.radius.button || t.radius.md)) || '8px';
  const el = styled('span', { background: hexOf(t, b.bg), color: hexOf(t, b.text), 'border-radius': radius, 'font-family': family(t) }, lab('Button', b));
  el.className = 'ds-btn';
  return el;
}
function buttons(t) {
  const rows = entries(t.buttons).map(([k, b]) => h('div', { class: 'ds-btn-row' }, buttonEl(t, b),
    h('div', {}, h('div', {}, h('b', {}, lab(k, b)), ' ', h('code', {}, k)),
      h('div', { class: 'hint' }, `Fill ${b.bg} · text ${b.text}`, ' '), aa(hexOf(t, b.text), hexOf(t, b.bg)))));
  return rows.length ? card('Buttons', ...rows) : null;
}
function surfaces(t) {
  const grid = h('div', { class: 'ds-surfaces' });
  for (const [k, s] of entries(t.surfaces)) {
    const bg = hexOf(t, s.bg), text = hexOf(t, s.text), head = hexOf(t, s.heading || s.text), accent = hexOf(t, s.accent);
    const sample = styled('div', { background: bg, color: text, 'font-family': family(t), 'border-radius': val(t.radius && t.radius.card) || '12px' },
      styled('div', { color: head, 'font-weight': '700', 'font-size': '20px', 'margin-bottom': '6px' }, `${lab(k, s)} section`),
      styled('div', { 'font-size': '14px', 'line-height': '1.5' }, 'Body text on this surface. ', styled('span', { color: accent, 'font-weight': '600' }, 'Accent link')),
      h('div', { class: 'ds-surface-btns' }, ...entries(t.buttons).filter(([, b]) => hexOf(t, b.bg) !== bg).slice(0, 2).map(([, b]) => buttonEl(t, b))));
    sample.className = 'ds-surface';
    grid.appendChild(h('div', {}, sample, h('div', { class: 'hint', style: 'margin-top:6px' }, h('code', {}, k), ' · text ', aa(text, bg) || '', ' · heading ', aa(head, bg, 3) || '')));
  }
  return grid.children.length ? card('Surfaces', h('p', { class: 'hint' }, 'Section backgrounds and the text, heading and accent colors that go on each.'), grid) : null;
}
function scales(t) {
  const blocks = [];
  const radius = bySize(t.radius);
  if (radius.length) blocks.push(h('h4', {}, 'Corner radius'), h('div', { class: 'ds-scale' }, ...radius.map(([k, x]) => h('div', { class: 'ds-scale-item' }, Object.assign(styled('div', { 'border-radius': val(x) }), { className: 'ds-radius-box' }), h('div', {}, h('b', {}, lab(k, x))), h('code', {}, String(val(x)))))));
  const space = bySize(t.space);
  if (space.length) blocks.push(h('h4', {}, 'Spacing'), ...space.map(([k, x]) => h('div', { class: 'ds-space-row' }, h('div', { class: 'ds-space-label' }, h('b', {}, lab(k, x)), ' ', h('code', {}, String(val(x)))), Object.assign(styled('div', { width: val(x) }), { className: 'ds-space-bar' }))));
  const shadow = entries(t.shadow);
  if (shadow.length) blocks.push(h('h4', {}, 'Shadows'), h('div', { class: 'ds-scale' }, ...shadow.map(([k, x]) => h('div', { class: 'ds-scale-item' }, Object.assign(styled('div', { 'box-shadow': val(x) }), { className: 'ds-shadow-box' }), h('div', {}, h('b', {}, lab(k, x)))))));
  return blocks.length ? card('Radius, spacing and shadows', ...blocks) : null;
}
function variants(t) {
  const rows = [];
  for (const [mod, settings] of entries(t.variants)) for (const [setting, list] of entries(settings)) {
    rows.push(h('div', { class: 'row' }, h('div', {}, h('div', { class: 'row-title' }, `${mod} · ${setting}`)), h('div', { class: 'row-meta' }, ...(Array.isArray(list) ? list : []).map((v) => h('span', { class: 'pill' }, String(v))))));
  }
  return rows.length ? card('Module variants', h('p', { class: 'hint' }, 'The only styles each page-builder module may use.'), h('div', { class: 'rows' }, ...rows)) : null;
}
function rules(t) {
  const list = (arr, kind) => (Array.isArray(arr) ? arr : []).map((r) => h('div', { class: 'row' }, h('div', {}, h('div', { class: 'row-title' }, r.label || r.id), h('div', { class: 'hint' }, r.check || '')), h('span', { class: `pill ${kind === 'hard' ? 'pill-hard' : ''}` }, kind === 'hard' ? 'Hard rule' : 'Guideline')));
  const rows = [...list(t.rules && t.rules.hard, 'hard'), ...list(t.rules && t.rules.soft, 'soft')];
  const locked = Array.isArray(t.locked) ? t.locked : ['logo', 'form', 'tracking'];
  return card('Rules', h('p', { class: 'hint' }, 'Hard rules can’t be overridden from the page. Guidelines can, with a logged exception.'), h('div', { class: 'rows' }, ...rows), h('p', { class: 'hint', style: 'margin-top:10px' }, `Locked from page edits: ${locked.join(', ')}.`));
}
export function renderSystem(t) {
  loadFont(t);
  return [colors(t), typeScale(t), buttons(t), surfaces(t), scales(t), variants(t), rules(t)].filter(Boolean);
}

// --------------------------------------------------------------- screens
export async function designScreen({ id }) {
  const [p, access, ds] = await Promise.all([getProject(id), projectAccess(id).catch(() => ({})), designSystem(id).catch(() => null)]);
  if (!p) return card('Not found', h('p', {}, 'This project doesn’t exist or you don’t have access.'));
  const da = access.design_rules || {};
  const back = h('a', { class: 'btn btn-ghost', href: `#/projects/${id}?to=design` }, 'Design rules settings');
  if (!ds || !ds.tokens || !ds.tokens.color) {
    return h('div', {}, pageHead('Design system', p.name, back), card('No design system yet', h('p', {}, 'The owner can paste one or import it from the site under Design rules in the project settings.')));
  }
  const t = ds.tokens;
  const head = pageHead(t.name ? `${t.name} design system` : 'Design system', `Version ${ds.version} · updated ${fmtDate(ds.updated_at)}${ds.updated_by ? ` by ${ds.updated_by}` : ''}${ds.source === 'connector' ? ' · from the site' : ''}`, back);
  const extra = [];

  // Pending rule changes, with approve / reject for the approver.
  const props = await designProposals(id).catch(() => []);
  const pending = props.filter((x) => x.status === 'pending');
  if (pending.length) {
    extra.push(card('Waiting on approval', h('div', { class: 'rows' }, ...pending.map((x) => {
      const meta = h('div', { class: 'row-meta' });
      if (da.can_approve && x.comment_id) {
        const no = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, 'Reject');
        const ok = h('button', { class: 'btn btn-sm', type: 'button' }, 'Approve');
        const act = async (action, b) => {
          b.disabled = true;
          try { await designFn({ project_id: id, action, comment_id: x.comment_id }); toast(action === 'approve' ? 'Approved' : 'Rejected'); location.reload(); }
          catch (e) { b.disabled = false; toast(e.message); }
        };
        no.addEventListener('click', () => act('reject', no));
        ok.addEventListener('click', () => act('approve', ok));
        meta.append(no, ok);
      }
      const pages = (x.affected || []).length;
      return h('div', { class: 'row' }, h('div', {}, h('div', { class: 'row-title' }, x.summary), h('div', { class: 'hint' }, `Asked by ${x.requested_by} · ${fmtDate(x.created_at)}${pages ? ` · ${pages} page${pages === 1 ? '' : 's'} affected` : ''}`),
        ...(x.affected || []).slice(0, 8).map((a) => h('div', { class: 'hint' }, h('a', { href: a.preview_url || a.url, target: '_blank', rel: 'noopener' }, a.title || a.url), a.preview_url ? ' (preview)' : ''))), meta);
    }))));
  }
  const ex = await designExceptions(id).catch(() => []);
  extra.push(card(`Exceptions (${ex.length})`, ex.length
    ? h('div', { class: 'rows' }, ...ex.map((e) => h('div', { class: 'row' }, h('div', {}, h('div', { class: 'row-title' }, `${e.property}: ${e.value}`), h('div', { class: 'hint' }, `${e.page_path || ''} ${e.selector || ''}`), h('div', { class: 'hint' }, `“${e.reason}” · ${e.created_by} · ${fmtDate(e.created_at)}`)))))
    : h('p', { class: 'hint' }, 'No one-off exceptions. Every element follows the rules.')));
  const log = await designChangelog(id).catch(() => []);
  if (log.length) extra.push(card('Changelog', h('div', { class: 'rows' }, ...log.map((l) => h('div', { class: 'row' }, h('div', {}, h('div', { class: 'row-title' }, l.summary), h('div', { class: 'hint' }, `${l.by || ''} · ${fmtDate(l.at)}`)), h('span', { class: 'pill' }, `v${l.version}`))))));
  const share = ds.share_token ? card('Share link', h('p', { class: 'hint' }, 'Anyone with this link can view the design system (colors, type, buttons, rules). Not the exceptions or changelog.'), copyBox(`${location.origin}${location.pathname}#/design/${ds.share_token}`)) : null;

  return h('div', { class: 'ds-page' }, head, ...renderSystem(t), ...extra, share);
}

export async function sharedDesignScreen(token) {
  let d = null;
  try { d = await sharedDesign(token); } catch { d = null; }
  if (!d || !d.tokens || !d.tokens.color) return card('Link not available', h('p', {}, 'This design system link was turned off, or it doesn’t exist.'));
  const head = pageHead(`${d.tokens.name || d.name} design system`, `Version ${d.version} · updated ${fmtDate(d.updated_at)}${d.exceptions ? ` · ${d.exceptions} logged exception${d.exceptions === 1 ? '' : 's'}` : ''}`);
  return h('div', { class: 'ds-page' }, head, ...renderSystem(d.tokens));
}
