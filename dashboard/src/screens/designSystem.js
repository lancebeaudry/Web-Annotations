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
import { card, pageHead, projectHeader } from '../ui/shell.js';
import { getProject, projectAccess, designSystem, designExceptions, designProposals, designChangelog, designFn, sharedDesign, openCounts } from '../api.js';
import { contrast, spacingScale, anatomyParts } from '../../../supabase/functions/_shared/designEngine.ts';

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
    grid.appendChild(h('div', { class: 'ds-swatch-card', 'data-key': k }, chip,
      h('div', { class: 'ds-sw-name' }, lab(k, c)),
      h('div', { class: 'ds-sw-meta' }, h('code', {}, hex || '?'), ' · ', h('code', {}, k)),
      c && c.usage ? h('div', { class: 'hint' }, c.usage) : null,
      hex && hex.toLowerCase() !== '#ffffff' && hex.toLowerCase() !== '#fff' ? h('div', { class: 'ds-sw-aa' }, h('span', { class: 'hint' }, 'As text on white'), aa(hex, '#ffffff') || '', h('span', { class: 'hint' }, 'White text on it'), aa('#ffffff', hex) || '') : null));
  }
  return grid.children.length ? card('Colors', grid) : null;
}
// ------------------------------------------------------------ copy CSS
// CSS built from the design system, with a comment naming the token each
// value comes from, so a developer can paste it or map it to variables.
const cssSafe = (v) => String(v ?? '').replace(/[{};<>]/g, '').trim();
const cls = (k) => String(k).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
function cssRule(selector, decls) {
  const lines = decls.filter(([, v]) => v).map(([p, v, note]) => `  ${p}: ${cssSafe(v)};${note ? ` /* ${cssSafe(note)} */` : ''}`);
  return lines.length ? `${selector} {\n${lines.join('\n')}\n}` : '';
}
function cssBox(text) {
  if (!text) return null;
  const copy = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, 'Copy');
  const code = h('code', {}, text);
  const done = () => { copy.textContent = 'Copied'; setTimeout(() => (copy.textContent = 'Copy'), 1500); };
  copy.addEventListener('click', async (e) => {
    e.preventDefault();
    try { await navigator.clipboard.writeText(text); return done(); } catch { /* blocked: try the older way */ }
    const ta = h('textarea', { style: 'position:fixed;left:-9999px;top:0', readonly: true });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    if (ok) return done();
    // Last resort: select the CSS so Cmd/Ctrl+C copies it.
    const range = document.createRange();
    range.selectNodeContents(code);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    toast('Selected. Press Cmd+C (Ctrl+C) to copy.');
  });
  return h('details', { class: 'ds-css' }, h('summary', {}, 'View CSS'), h('div', { class: 'ds-css-body' }, h('pre', {}, code), copy));
}
const colorDecl = (t, prop, key) => [prop, hexOf(t, key), key && t.color && t.color[key] ? `color.${key}` : ''];
function buttonCss(t, k, b) {
  const rk = t.radius && (t.radius.button ? 'button' : t.radius.md ? 'md' : '');
  return cssRule(`.btn-${cls(k)}`, [
    colorDecl(t, 'background', b.bg),
    colorDecl(t, 'color', b.text),
    ['border-radius', rk ? val(t.radius[rk]) : '', rk ? `radius.${rk}` : ''],
    ['padding', b.padding, `buttons.${k}.padding`],
    ['font-family', family(t), 'font.family'],
    ['font-size', b.font_size, `buttons.${k}.font_size`],
    ['font-weight', b.font_weight, `buttons.${k}.font_weight`],
    ['box-shadow', t.shadow && t.shadow.button ? val(t.shadow.button) : '', t.shadow && t.shadow.button ? 'shadow.button' : ''],
  ]);
}
function surfaceCss(t, k, s) {
  const sel = `.section-${cls(k)}`;
  return [
    cssRule(sel, [colorDecl(t, 'background', s.bg), colorDecl(t, 'color', s.text)]),
    s.heading ? cssRule(`${sel} :is(h1, h2, h3, h4)`, [colorDecl(t, 'color', s.heading)]) : '',
    s.accent ? cssRule(`${sel} a`, [colorDecl(t, 'color', s.accent)]) : '',
  ].filter(Boolean).join('\n\n');
}
function typeCss(t, k, x) {
  return cssRule(`.text-${cls(k)}`, [['font-size', val(x), `type.${k}`], ['font-family', family(t), 'font.family']]);
}
function typeScale(t) {
  const fam = family(t);
  const rows = bySize(t.type, true).map(([k, x]) => h('div', { class: 'ds-type-row', 'data-key': k },
    h('div', { class: 'ds-type-meta' }, h('b', {}, lab(k, x)), h('code', {}, String(val(x) || ''))),
    styled('div', { 'font-size': val(x), 'font-family': fam, 'line-height': '1.2', 'font-weight': /display|h\d|head/i.test(k) ? '700' : '400' }, 'The quick brown fox jumps over the lazy dog'),
    cssBox(typeCss(t, k, x))));
  const famRow = fam ? h('p', {}, 'Font: ', h('b', {}, lab('', t.font && t.font.family) || fam), h('span', { class: 'hint' }, ` (${fam})`)) : null;
  return rows.length || famRow ? card('Typography', famRow, ...rows) : null;
}
function buttonEl(t, b) {
  const radius = val(t.radius && (t.radius.button || t.radius.md)) || '8px';
  const el = styled('span', { background: hexOf(t, b.bg), color: hexOf(t, b.text), 'border-radius': radius, 'font-family': family(t), 'font-weight': b.font_weight || '' }, lab('Button', b));
  el.className = 'ds-btn';
  return el;
}
function buttons(t) {
  const rows = entries(t.buttons).map(([k, b]) => h('div', { class: 'ds-btn-row', 'data-key': k }, buttonEl(t, b),
    h('div', {}, h('div', {}, h('b', {}, lab(k, b)), ' ', h('code', {}, k)),
      h('div', { class: 'hint' }, `Fill ${b.bg} · text ${b.text}${b.padding ? ` · padding ${b.padding}` : ''}${b.font_size ? ` · ${b.font_size}` : ''}`, ' '), aa(hexOf(t, b.text), hexOf(t, b.bg)),
      cssBox(buttonCss(t, k, b)))));
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
    grid.appendChild(h('div', { 'data-key': k }, sample, h('div', { class: 'hint', style: 'margin-top:6px' }, h('code', {}, k), ' · text ', aa(text, bg) || '', ' · heading ', aa(head, bg, 3) || ''), cssBox(surfaceCss(t, k, s))));
  }
  return grid.children.length ? card('Surfaces', h('p', { class: 'hint' }, 'Section backgrounds and the text, heading and accent colors that go on each.'), grid) : null;
}
function scales(t) {
  const blocks = [];
  const radius = bySize(t.radius);
  if (radius.length) blocks.push(h('h4', {}, 'Corner radius'), h('div', { class: 'ds-scale' }, ...radius.map(([k, x]) => h('div', { class: 'ds-scale-item' }, Object.assign(styled('div', { 'border-radius': val(x) }), { className: 'ds-radius-box' }), h('div', {}, h('b', {}, lab(k, x))), h('code', {}, String(val(x)))))));
  // Layout values (content width, gutter, section padding); the spacing
  // scale has its own card when the design system defines one.
  const hasScale = Object.keys(spacingScale(t)).length > 0;
  const space = bySize(t.space).filter(([, x]) => !(hasScale && x && x.scale));
  if (space.length) blocks.push(h('h4', {}, hasScale ? 'Layout' : 'Spacing'), ...space.map(([k, x]) => h('div', { class: 'ds-space-row' }, h('div', { class: 'ds-space-label' }, h('b', {}, lab(k, x)), ' ', h('code', {}, String(val(x)))), Object.assign(styled('div', { width: val(x) }), { className: 'ds-space-bar' }))));
  const shadow = entries(t.shadow);
  if (shadow.length) blocks.push(h('h4', {}, 'Shadows'), h('div', { class: 'ds-scale' }, ...shadow.map(([k, x]) => h('div', { class: 'ds-scale-item' }, Object.assign(styled('div', { 'box-shadow': val(x) }), { className: 'ds-shadow-box' }), h('div', {}, h('b', {}, lab(k, x)))))));
  return blocks.length ? card(hasScale ? 'Radius, layout and shadows' : 'Radius, spacing and shadows', ...blocks) : null;
}
function spacing(t) {
  const steps = bySize(spacingScale(t));
  if (!steps.length) return null;
  return card('Spacing scale', h('p', { class: 'hint' }, 'Every gap, margin and padding inside a section uses one of these steps.'),
    ...steps.map(([k, x]) => h('div', { class: 'ds-space-row ds-step', 'data-key': k },
      h('div', { class: 'ds-space-label' }, h('b', {}, lab(k, x)), ' ', h('code', {}, String(val(x)))),
      Object.assign(styled('div', { width: val(x) }), { className: 'ds-space-bar' }),
      x && x.use ? h('span', { class: 'hint' }, x.use) : null)));
}
// A sample section with its spacing drawn in, numbered to match the table.
function anatomy(t) {
  const parts = anatomyParts(t);
  if (!parts.length) return null;
  const by = Object.fromEntries(parts.map((p, i) => [p.id, { ...p, n: i + 1 }]));
  const gap = (id) => {
    const p = by[id];
    if (!p) return null;
    const g = styled('div', { height: p.value });
    g.className = 'ds-anat-gap';
    g.title = p.label;
    g.appendChild(h('b', {}, String(p.n)));
    return g;
  };
  const cardsRow = styled('div', { gap: by.items ? by.items.value : '24px' }, ...[0, 1, 2].map(() => {
    const c = styled('div', { padding: by['card-padding'] ? by['card-padding'].value : '24px' }, h('span', {}), h('span', {}));
    c.className = 'ds-anat-card';
    return c;
  }));
  cardsRow.className = 'ds-anat-cards';
  const inner = styled('div', { 'max-width': by['text-width'] ? by['text-width'].value : '720px', 'font-family': family(t) },
    h('div', { class: 'ds-anat-eyebrow' }, 'Eyebrow'), gap('eyebrow-heading'),
    h('div', { class: 'ds-anat-h' }, 'Section heading'), gap('heading-text'),
    h('div', { class: 'ds-anat-p' }, 'Intro text that explains the section in a sentence or two.'), gap('text-text'),
    h('div', { class: 'ds-anat-p' }, 'A second paragraph when it needs one.'));
  const frame = styled('div', { padding: `${by.padding ? by.padding.value : '48px'} 24px`, 'font-family': family(t) },
    inner, gap('heading-content'), cardsRow, gap('content-actions'), h('span', { class: 'ds-anat-btn' }, 'Button'));
  frame.className = 'ds-anat-frame';
  const table = h('table', { class: 'ds-anat-table' }, h('tbody', {}, ...parts.map((p, i) => h('tr', { 'data-key': p.id },
    h('td', {}, h('span', { class: 'ds-num' }, String(i + 1)), p.label, p.note ? h('div', { class: 'hint' }, p.note) : null),
    h('td', {}, h('code', {}, p.value), p.alt ? h('div', {}, h('code', {}, p.alt)) : null)))));
  return card('Section anatomy', h('p', { class: 'hint' }, 'How the parts of every section are spaced, top to bottom.'), h('div', { class: 'ds-anat' }, frame, table));
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
  // Section ids let PinPoint link straight to the part a flag refers to:
  // #/design/<token>?to=buttons&item=primary
  const parts = [['colors', colors(t)], ['typography', typeScale(t)], ['buttons', buttons(t)], ['surfaces', surfaces(t)], ['spacing', spacing(t)], ['anatomy', anatomy(t)], ['scales', scales(t)], ['variants', variants(t)], ['rules', rules(t)]];
  return parts.filter(([, el]) => el).map(([id, el]) => { el.id = `ds-${id}`; return el; });
}
// Scroll to the section named in ?to= and highlight ?item= inside it.
function focusFrom(query = {}) {
  const to = String(query.to || '').replace(/[^a-z]/g, '');
  if (!to) return;
  const item = String(query.item || '').replace(/[^A-Za-z0-9_-]/g, '');
  setTimeout(() => {
    const sec = document.getElementById(`ds-${to}`) || ((to === 'spacing' || to === 'anatomy') && document.getElementById('ds-scales'));
    if (!sec) return;
    const hit = item ? sec.querySelector(`[data-key="${item}"]`) : null;
    const target = hit || sec;
    target.scrollIntoView({ block: hit ? 'center' : 'start' });
    if (!hit) window.scrollBy(0, -84);
    target.classList.add('ds-hl');
    setTimeout(() => target.classList.remove('ds-hl'), 4500);
  }, 80);
}

// --------------------------------------------------------------- screens
export async function designScreen({ id, query = {} }) {
  const [p, access, ds, counts] = await Promise.all([getProject(id), projectAccess(id).catch(() => ({})), designSystem(id).catch(() => null), openCounts().catch(() => ({}))]);
  if (!p) return card('Not found', h('p', {}, 'This project doesn’t exist or you don’t have access.'));
  const da = access.design_rules || {};
  const tabs = projectHeader(p, 'design', { openCount: counts[id] || 0, design: true });
  const back = h('a', { class: 'btn btn-ghost btn-sm', href: `#/projects/${id}?to=design` }, 'Design rules settings');
  const subhead = (title, meta) => h('div', { class: 'ds-subhead' }, h('div', {}, h('h2', {}, title), meta ? h('div', { class: 'sub' }, meta) : null), back);
  // A draft an AI assistant sent in: preview it in full, with Use / Discard.
  const draft = ds && ds.draft && ds.draft.color ? ds.draft : null;
  if (draft && (query.draft || !(ds.tokens && ds.tokens.color))) {
    const boss = ['owner', 'operator'].includes(access.role);
    const use = h('button', { class: 'btn btn-sm', type: 'button' }, ds.tokens && ds.tokens.color ? 'Replace the current design system' : 'Use this design system');
    const drop = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, 'Discard');
    const act = (action, btn, msg, to) => btn.addEventListener('click', async () => {
      btn.disabled = true;
      try { const r = await designFn({ project_id: id, action }); toast(msg(r)); location.hash = to; location.reload(); }
      catch (e) { btn.disabled = false; toast(e.message); }
    });
    act('draft_approve', use, (r) => `Design system v${r.version} is in use`, `#/projects/${id}/design`);
    act('draft_discard', drop, () => 'Draft discarded', `#/projects/${id}?to=design`);
    const banner = h('div', { class: 'ds-draft' },
      h('div', {}, h('b', {}, 'Draft, not in use yet'), ` · sent by ${ds.draft_by || 'an AI assistant'}${ds.draft_at ? ` on ${fmtDate(ds.draft_at)}` : ''}`),
      ds.draft_summary ? h('p', { class: 'ds-draft-sum' }, ds.draft_summary) : null,
      boss ? h('div', { class: 'btn-row ds-left' }, use, drop) : h('p', { class: 'hint' }, 'The project owner decides whether to use it.'));
    focusFrom(query);
    return h('div', { class: 'ds-page' }, tabs, subhead(`${draft.name || 'Design system'} (draft)`, `Version ${draft.version || '1.0.0'}`), banner, ...renderSystem(draft));
  }
  if (!ds || !ds.tokens || !ds.tokens.color) {
    return h('div', {}, tabs, subhead('Design system', ''), card('No design system yet', h('p', {}, 'The owner can import it from the site’s design system page under Design rules in the project settings, or create one with Claude Code from there.')));
  }
  const t = ds.tokens;
  const head = h('div', {}, tabs, subhead(t.name || 'Design system', `Version ${ds.version} · updated ${fmtDate(ds.updated_at)}${ds.updated_by ? ` by ${ds.updated_by}` : ''}${ds.source === 'connector' || ds.source === 'url' ? ' · imported from the site' : ''}`));
  const extra = [];
  if (draft) extra.push(h('div', { class: 'ds-draft' }, h('b', {}, `A new draft is waiting`), ` from ${ds.draft_by || 'an AI assistant'}. `, h('a', { href: `#/projects/${id}/design?draft=1` }, 'Preview it')));

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

  focusFrom(query);
  return h('div', { class: 'ds-page' }, head, ...extra.filter((x) => x.classList && x.classList.contains('ds-draft')), ...renderSystem(t), ...extra.filter((x) => !(x.classList && x.classList.contains('ds-draft'))), share);
}

export async function sharedDesignScreen(token, query = {}) {
  let d = null;
  try { d = await sharedDesign(token); } catch { d = null; }
  if (!d || !d.tokens || !d.tokens.color) return card('Link not available', h('p', {}, 'This design system link was turned off, or it doesn’t exist.'));
  const head = pageHead(`${d.tokens.name || d.name} design system`, `Version ${d.version} · updated ${fmtDate(d.updated_at)}${d.exceptions ? ` · ${d.exceptions} logged exception${d.exceptions === 1 ? '' : 's'}` : ''}`);
  focusFrom(query);
  return h('div', { class: 'ds-page' }, head, ...renderSystem(d.tokens));
}
