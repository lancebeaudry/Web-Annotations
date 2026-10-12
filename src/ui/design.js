// Design rules in the overlay: the "Style change" mode of the comment box,
// and the status card on a thread. Only active when the project has design
// rules switched on and the viewer is a member (the server decides both;
// see design_rules_access). Everything here goes through the design-rules
// edge function; nothing about a decision is written from the browser.

import { h, toast } from './overlay.js';
import { buildSelector } from '../capture.js';
import { DASHBOARD_URL } from '../config.js';
import { hint as designHint } from '../../supabase/functions/_shared/designEngine.ts';

export const designOn = (app) => !!(app.access && app.access.design_rules && app.access.design_rules.can_check);

// ------------------------------------------------------------------ API
export async function designCall(app, body) {
  const { data, error } = await app.supabase.functions.invoke('design-rules', { body: { project_id: app.project.id, ...body } });
  if (!error) return data;
  let payload = null;
  try { payload = await error.context.json(); } catch { /* not JSON */ }
  const err = new Error((payload && (payload.message || payload.error)) || 'Couldn’t reach the design rules. Try again.');
  err.payload = payload;
  throw err;
}
export async function loadRules(app, force = false) {
  const c = app.designRules;
  if (!force && c && Date.now() - c.at < 300000) return c.data;
  const data = await designCall(app, { action: 'rules' });
  app.designRules = { at: Date.now(), data };
  return data;
}

// Link to the design system page, at the section a result refers to. Uses
// the view-only share page when the owner turned it on (no sign-in),
// otherwise the members' page in the dashboard.
const SECTION_FOR = { buttons: 'buttons', palette: 'colors', contrast: 'colors', type: 'typography', radius: 'scales', spacing: 'spacing', anatomy: 'anatomy', variants: 'variants', logo: 'rules', tracking: 'rules', manual: 'rules' };
export function designSystemUrl(app, to = '', item = '') {
  const d = app.designRules && app.designRules.data;
  const q = to ? `?to=${encodeURIComponent(to)}${item ? `&item=${encodeURIComponent(item)}` : ''}` : '';
  return d && d.share_token ? `${DASHBOARD_URL}#/design/${d.share_token}${q}` : `${DASHBOARD_URL}#/projects/${app.project.id}/design${q}`;
}
export function designSystemUrlFor(app, request, res) {
  const rid = res && res.rule ? res.rule.id : '';
  const to = SECTION_FOR[rid] || '';
  const ctx = (request && request.context) || {};
  let item = '';
  let sec = to;
  if (to === 'buttons') item = ctx.button || '';
  else if (res && res.token && /^space\./.test(res.token)) { sec = 'spacing'; item = res.token.split('.')[1]; }
  else if (res && res.token && /^(type|color)\./.test(res.token)) item = res.token.split('.')[1];
  return designSystemUrl(app, sec, item);
}

// ------------------------------------------------- reading the element
const ELEMENTS = [
  ['button', 'Button'], ['heading', 'Heading'], ['display', 'Main headline'], ['text', 'Text'],
  ['section', 'Section'], ['logo', 'Logo'], ['form', 'Form'],
];
const PROPS = {
  'background-color': 'Background color', color: 'Text color', 'border-color': 'Border color',
  'border-radius': 'Corner radius', 'font-size': 'Text size', padding: 'Spacing', margin: 'Space around', variant: 'Section style',
};
const COLOR_PROPS = ['background-color', 'color', 'border-color'];
export const propLabel = (p) => PROPS[p] || p;
export const elementLabel = (e) => (ELEMENTS.find((x) => x[0] === e) || [e, e])[1];

function hex(c) {
  const m = String(c || '').match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?/);
  if (!m) return /^#[0-9a-f]{3,6}$/i.test(c || '') ? c.toLowerCase() : '';
  if (m[4] !== undefined && +m[4] === 0) return '';
  return '#' + [m[1], m[2], m[3]].map((n) => (+n).toString(16).padStart(2, '0')).join('');
}
function effectiveBackground(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const b = hex(getComputedStyle(n).backgroundColor);
    if (b) return b;
  }
  return '#ffffff';
}
// A style key from the site's own markup: an explicit `match` selector in
// the design system wins; otherwise BEM-ish class names such as
// `xyz-btn--dark`, `is-style-btn-dark` or `surface--light`.
function keyFrom(el, group, word, up) {
  if (!group) return null;
  for (const [k, v] of Object.entries(group)) {
    if (v && v.match) { try { if (up ? el.closest(v.match) : el.matches(v.match)) return k; } catch { /* bad selector */ } }
  }
  const re = new RegExp(`(?:^|[-_])${word}[-_]{1,2}([a-z0-9-]+)$`);
  for (let n = el; n && n.nodeType === 1; n = up ? n.parentElement : null) {
    for (const c of n.classList || []) {
      const m = c.toLowerCase().match(re);
      if (m && group[m[1]]) return m[1];
    }
    if (!up) break;
  }
  return null;
}
// No class or selector to go on: fall back to the colors actually on the
// page. A button whose background and text match a token pair is that
// button style; a section whose background matches a surface is that one.
const tokenHex = (tokens, key) => {
  const c = tokens && tokens.color && tokens.color[key];
  return (c && String(c.value || c).toLowerCase()) || '';
};
function keyByColor(tokens, group, bg, text) {
  if (!tokens || !group || !bg) return null;
  let loose = null;
  for (const [k, v] of Object.entries(group)) {
    if (!v || tokenHex(tokens, v.bg) !== bg) continue;
    if (!text || tokenHex(tokens, v.text) === text) return k;
    loose = loose || k;
  }
  return loose;
}
export function designContext(el, tokens) {
  const btn = el.closest('a, button, input[type=submit], [role=button]');
  const looksButton = btn && (btn.tagName !== 'A' || /btn|button/i.test(btn.className || '') || getComputedStyle(btn).display.includes('inline-block') || getComputedStyle(btn).paddingTop !== '0px');
  const tag = el.tagName;
  const element = el.closest('[class*=logo], .custom-logo-link') ? 'logo'
    : el.closest('form, input, select, textarea') && !looksButton ? 'form'
    : looksButton ? 'button'
    : tag === 'H1' ? 'display'
    : /^H[2-4]$/.test(tag) ? 'heading'
    : /^(SECTION|HEADER|FOOTER|MAIN)$/.test(tag) || el.getBoundingClientRect().width > window.innerWidth * 0.8 ? 'section'
    : 'text';
  const target = element === 'button' && btn ? btn : el;
  const cs = getComputedStyle(target);
  const node = target.closest('[data-node]');
  const moduleEl = target.closest('[class*="fl-module-"]');
  const mod = moduleEl ? ([...moduleEl.classList].find((c) => c.startsWith('fl-module-') && c !== 'fl-module-content') || '').replace('fl-module-', '') : '';
  const pid = (document.body.className.match(/(?:^|\s)page-id-(\d+)/) || [])[1];
  return {
    element,
    el: target,
    target: { page_id: pid ? +pid : 0, node_id: node ? node.getAttribute('data-node') : '', module: mod, selector: buildSelector(target) },
    context: {
      button: element !== 'button' ? null : (tokens && keyFrom(target, tokens.buttons, '(?:btn|button)', false)) || keyByColor(tokens, tokens && tokens.buttons, hex(cs.backgroundColor), hex(cs.color)),
      surface: (tokens && keyFrom(target, tokens.surfaces, 'surface', true)) || keyByColor(tokens, tokens && tokens.surfaces, element === 'section' ? (hex(cs.backgroundColor) || effectiveBackground(target)) : effectiveBackground(element === 'button' && target.parentElement ? target.parentElement : target), null),
      background: element === 'button' ? (hex(cs.backgroundColor) || effectiveBackground(target)) : effectiveBackground(target),
      text: hex(cs.color),
    },
    computed: {
      'background-color': hex(cs.backgroundColor), color: hex(cs.color), 'border-color': hex(cs.borderTopColor), 'border-radius': cs.borderTopLeftRadius, 'font-size': cs.fontSize, padding: cs.paddingTop,
      // The space above/below comes from this element or its neighbour,
      // whichever is larger (margins collapse).
      margin: `${Math.max(parseFloat(cs.marginTop) || 0, target.previousElementSibling ? parseFloat(getComputedStyle(target.previousElementSibling).marginBottom) || 0 : 0)}px`,
      'margin-bottom': `${Math.max(parseFloat(cs.marginBottom) || 0, target.nextElementSibling ? parseFloat(getComputedStyle(target.nextElementSibling).marginTop) || 0 : 0)}px`,
      // Space between siblings usually comes from the parent's gap.
      gap: target.parentElement ? getComputedStyle(target.parentElement).rowGap : '',
    },
  };
}

// ------------------------------------------------- style change panel
// Returns { node, focus } to place in the comment box. `post(text, extra)`
// is supplied by the comment box: it saves the comment and resolves to the
// new row, or null.
export function stylePanel(app, el, post, prefill = null) {
  const wrap = h('div', { class: 'ds-panel' });
  const status = h('div', { class: 'ds-loading' }, 'Loading the design rules…');
  wrap.appendChild(status);
  let tokens = null, ctx = null, version = null;

  const elementSel = h('select', { class: 'ds-select', 'aria-label': 'What is it?' }, ...ELEMENTS.map(([v, l]) => h('option', { value: v }, l)));
  const propSel = h('select', { class: 'ds-select', 'aria-label': 'What should change?' });
  const colorIn = h('input', { type: 'color', class: 'ds-color', 'aria-label': 'Pick a color' });
  const valueIn = h('input', { type: 'text', class: 'ds-value', placeholder: '#1a7f37', 'aria-label': 'New value' });
  const variantList = h('datalist', { id: `ds-variants-${Math.random().toString(36).slice(2, 7)}` });
  const note = h('textarea', { rows: '2', class: 'ds-note', placeholder: 'Anything else? (optional)' });
  const checkBtn = h('button', { type: 'button', class: 'btn' }, 'Check');
  const out = h('div', { class: 'ds-result' });

  colorIn.addEventListener('input', () => { valueIn.value = colorIn.value; out.replaceChildren(); });
  valueIn.addEventListener('input', () => { if (/^#[0-9a-f]{6}$/i.test(valueIn.value.trim())) colorIn.value = valueIn.value.trim(); out.replaceChildren(); });
  const isColor = () => COLOR_PROPS.includes(propSel.value);
  const fillProps = () => {
    const e = elementSel.value;
    const props = e === 'section' ? ['background-color', 'variant', 'padding'] : e === 'button' ? ['background-color', 'color', 'padding', 'border-radius', 'border-color', 'font-size'] : ['color', 'font-size', 'background-color', 'margin', 'padding', 'border-radius'];
    const hasVariants = ctx && ctx.target.module && tokens && tokens.variants && tokens.variants[ctx.target.module];
    propSel.replaceChildren(...props.filter((p) => p !== 'variant' || hasVariants).map((p) => h('option', { value: p }, propLabel(p))));
    syncValue();
  };
  const syncValue = () => {
    out.replaceChildren();
    colorIn.style.display = isColor() ? '' : 'none';
    if (propSel.value === 'variant') {
      const settings = (tokens.variants || {})[ctx.target.module] || {};
      const setting = Object.keys(settings)[0] || '';
      ctx.target.setting = setting;
      variantList.replaceChildren(...(settings[setting] || []).map((v) => h('option', { value: v })));
      valueIn.setAttribute('list', variantList.id);
      valueIn.placeholder = (settings[setting] || []).join(', ') || 'Variant name';
      valueIn.value = '';
    } else {
      valueIn.removeAttribute('list');
      const cur = ctx && ctx.computed[propSel.value];
      valueIn.placeholder = isColor() ? '#1a7f37' : (cur || '16px');
      valueIn.value = isColor() && cur ? cur : '';
      if (isColor() && cur) colorIn.value = cur;
    }
  };
  elementSel.addEventListener('change', fillProps);
  propSel.addEventListener('change', syncValue);

  const request = () => ({
    element: elementSel.value,
    property: propSel.value,
    value: valueIn.value.trim(),
    context: { ...ctx.context, current: propSel.value === 'variant' ? '' : (ctx.computed[propSel.value] || '') },
    target: { ...ctx.target, page_path: app.pagePath },
    viewport_w: window.innerWidth,
  });
  const summaryText = (r) => `Style change: ${elementLabel(r.element).toLowerCase()} ${propLabel(r.property).toLowerCase()} → ${r.value}`;

  checkBtn.addEventListener('click', async () => {
    const r = request();
    if (!r.value) return toast(app.ui, 'Enter the new value first');
    checkBtn.disabled = true; checkBtn.textContent = 'Checking…';
    try {
      const { result } = await designCall(app, { action: 'check', request: r });
      renderResult(r, result);
    } catch (err) { out.replaceChildren(h('div', { class: 'ds-err' }, err.message)); }
    checkBtn.disabled = false; checkBtn.textContent = 'Check again';
  });

  // Save the comment, then record the choice on it.
  async function choose(r, body, btn) {
    btn.disabled = true;
    const text = [summaryText(r), note.value.trim()].filter(Boolean).join('\n');
    const row = await post(text);
    if (!row) { btn.disabled = false; return; }
    try {
      const res = await designCall(app, { action: 'decide', comment_id: row.id, request: r, tokens_version: version, ...body });
      app.comments.set(res.comment.id, res.comment);
      app.refresh();
      toast(app.ui, DONE[res.comment.design_check.state] || 'Saved');
    } catch (err) {
      if (err.payload && err.payload.error === 'RULES_CHANGED' && err.payload.result) {
        toast(app.ui, 'The design system changed. Your comment is saved; check it again from the thread.');
      } else toast(app.ui, `Comment saved, but: ${err.message}`);
      app.refresh();
    }
  }

  function renderResult(r, res) {
    version = res.tokens_version;
    const tone = res.status === 'allowed' ? 'ok' : res.status === 'blocked' ? 'no' : 'warn';
    const head = { ok: 'Approved', warn: 'Needs a decision', no: 'Can’t be approved' }[tone];
    const parts = [
      h('div', { class: `ds-badge ds-${tone}` }, h('b', {}, head), h('span', {}, ` · ${res.rule.label}`)),
      h('div', { class: 'ds-msg' }, res.message),
    ];
    if (res.contrast && res.contrast.ratio != null) parts.push(h('div', { class: 'ds-sub' }, `Contrast ${res.contrast.ratio}:1 against ${res.contrast.against} (needs ${res.contrast.min}:1)`));
    if (res.device_note) parts.push(h('div', { class: 'ds-sub' }, res.device_note));
    if (res.status === 'allowed') {
      const b = h('button', { type: 'button', class: 'btn btn-teal' }, 'Apply');
      b.addEventListener('click', () => choose(r, { choice: 'apply' }, b));
      parts.push(h('div', { class: 'ds-actions' }, b));
    }
    const da = app.access.design_rules;
    for (const o of res.options || []) {
      if (o.id === 'closest') {
        const sw = /^#[0-9a-f]{6}$/i.test(o.value || '') ? h('span', { class: 'ds-swatch', style: `background:${o.value}` }) : null;
        const pick = o.choices ? h('select', { class: 'ds-select' }, ...o.choices.map((c) => h('option', { value: c }, c))) : null;
        const b = h('button', { type: 'button', class: 'btn btn-sm' }, 'Use this');
        b.addEventListener('click', () => choose(r, { choice: 'closest', variant: pick ? pick.value : undefined }, b));
        parts.push(h('div', { class: 'ds-opt' }, h('div', { class: 'ds-opt-h' }, sw, h('b', {}, o.label)), h('div', { class: 'ds-sub' }, o.summary), pick, h('div', { class: 'ds-actions' }, b)));
      } else if (o.id === 'exception') {
        const reason = h('input', { type: 'text', class: 'ds-value', placeholder: 'Why this one is different (required)' });
        const b = h('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, da.can_except ? 'Make exception' : 'Ask for an exception');
        b.addEventListener('click', () => {
          if (reason.value.trim().length < 3) { reason.focus(); return toast(app.ui, 'Add a short reason'); }
          choose(r, { choice: 'exception', reason: reason.value.trim() }, b);
        });
        parts.push(h('div', { class: 'ds-opt' }, h('div', { class: 'ds-opt-h' }, h('b', {}, o.label)), h('div', { class: 'ds-sub' }, da.can_except ? o.summary : 'An approver decides. You’ll see the answer on this item.'), reason, h('div', { class: 'ds-actions' }, b)));
      } else if (o.id === 'rule_change') {
        const name = `ds-scope-${Math.random().toString(36).slice(2, 7)}`;
        const radios = (o.scopes || []).map((s, i) => {
          const rb = h('input', { type: 'radio', name, value: s.id });
          if (i === 0) rb.checked = true;
          return h('label', { class: 'ds-scope' }, rb, h('span', {}, h('b', {}, s.label), s.impact ? h('span', { class: 'ds-sub' }, ` ${s.impact}`) : null));
        });
        const b = h('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, da.connected ? 'Preview affected pages' : 'Propose rule change');
        b.addEventListener('click', () => {
          const sel = wrap.querySelector(`input[name="${name}"]:checked`);
          choose(r, { choice: 'rule_change', scope_id: sel ? sel.value : '' }, b);
        });
        const sum = da.connected ? o.summary : 'Update the design system. The approver decides, then it becomes a ready-to-do change.';
        parts.push(h('div', { class: 'ds-opt' }, h('div', { class: 'ds-opt-h' }, h('b', {}, o.label)), h('div', { class: 'ds-sub' }, sum), ...radios, h('div', { class: 'ds-actions' }, b)));
      }
    }
    if (res.status === 'blocked' || res.rule.id === 'manual') {
      const b = h('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, 'Send to the team');
      b.addEventListener('click', () => choose(r, { choice: 'send' }, b));
      parts.push(h('div', { class: 'ds-actions ds-send' }, h('span', { class: 'ds-sub' }, 'The team can handle it for you.'), b));
    }
    out.replaceChildren(...parts);
  }

  (async () => {
    try {
      const data = await loadRules(app);
      if (!data.tokens || !data.tokens.color) { status.textContent = 'This project has no design system yet. The owner can add one in the dashboard.'; return; }
      tokens = data.tokens;
      ctx = designContext(el, tokens);
      elementSel.value = (prefill && prefill.element) || ctx.element;
      fillProps();
      if (prefill && prefill.property && [...propSel.options].some((o) => o.value === prefill.property)) {
        propSel.value = prefill.property;
        syncValue();
      }
      if (prefill && prefill.value) {
        valueIn.value = prefill.value;
        if (/^#[0-9a-f]{6}$/i.test(prefill.value)) colorIn.value = prefill.value;
      }
      const ver = h('div', { class: 'ds-sub' }, `${tokens.name || 'Design system'} v${data.version}${data.production_version ? (data.production_version === data.version ? ' · live on production' : ` · production is v${data.production_version}`) : ''}`);
      status.replaceWith(
        h('div', { class: 'ds-row' }, h('label', {}, 'What is it?', elementSel), h('label', {}, 'Change', propSel)),
        h('div', { class: 'ds-row ds-valrow' }, colorIn, valueIn, variantList, checkBtn),
        note, out, ver);
    } catch (err) { status.textContent = err.message; }
  })();
  return { node: wrap, focus: () => valueIn.focus() };
}

// ------------------------------------------------- the instant flag
// Reads a plain comment for a style request ("less padding on this
// button", "make the heading red") and checks it against the design system
// while the person types. No AI and no network: the rules are already
// loaded and the checker runs in the page.
const LESS = /\b(less|smaller|tighter|reduce|decrease|shrink|thinner|narrower|sharper|squarer|closer|too (big|large|much|wide|tall|rounded|roomy|far))\b/;
const MORE = /\b(more|bigger|larger|increase|roomier|wider|taller|rounder|further|farther|too (small|tight|narrow|cramped|thin|close))\b/;
export function readIntent(text) {
  const s = ` ${String(text || '').toLowerCase()} `;
  const hexm = s.match(/#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/);
  const pxm = s.match(/\b(\d{1,3}(?:\.\d+)?)\s*px\b/);
  let property = null;
  // Space above / below / between things: the section anatomy.
  const where = /\b(between|apart)\b/.test(s) ? 'between' : /\b(below|under|underneath|after)\b/.test(s) ? 'below' : /\b(above|over|before)\b/.test(s) ? 'above' : '';
  if ((where && /\b(space|spacing|gap|room|margin|distance|closer|further|farther)\b/.test(s)) || /\b(closer|further away|farther away|further apart|farther apart|spread (it |them )?out)\b/.test(s)) property = 'margin';
  else if (/\b(padding|padded|spacing|space (around|inside)|breathing room|white ?space|tighter|roomier|cramped)\b/.test(s)) property = 'padding';
  else if (/\b(rounded|rounder|round corners?|corners?|radius|pill[- ]shaped)\b/.test(s)) property = 'border-radius';
  else if (/\bfont[- ]?size\b|\btext size\b/.test(s) || (/\b(font|text|type|headline|heading|title|copy|words?|label)\b/.test(s) && /\b(bigger|smaller|larger|huge|tiny|size)\b/.test(s))) property = 'font-size';
  else if (/\b(background|bg|fill)\b/.test(s)) property = 'background-color';
  else if (/\b(text|font) colou?r\b/.test(s)) property = 'color';
  else if (hexm || /\b(colou?r|red|blue|green|black|white|gr[ae]y|orange|yellow|purple|pink|navy|teal|darker|lighter|brighter)\b/.test(s)) property = '*color';
  if (!property) return null;
  const direction = LESS.test(s) ? 'less' : MORE.test(s) ? 'more' : '';
  const value = property.endsWith('color') ? (hexm ? hexm[0] : '') : (pxm ? `${pxm[1]}px` : '');
  return { property, direction, value, where };
}

export function attachFlag(app, el, input, onCheck) {
  const node = h('div', { class: 'ds-flag', hidden: true });
  let last = null, ctx = null, timer = null, tokens = null;
  loadRules(app).then((d) => { tokens = d && d.tokens && d.tokens.color ? d.tokens : null; if (tokens) ctx = designContext(el, tokens); run(); }).catch(() => {});
  function run() {
    last = null;
    const intent = tokens && ctx ? readIntent(input.value) : null;
    if (!intent) { node.hidden = true; return; }
    const property = intent.property === '*color' ? (['button', 'section'].includes(ctx.element) ? 'background-color' : 'color') : intent.property;
    const request = {
      element: ctx.element, property, value: intent.value,
      context: { ...ctx.context, current: property === 'margin' ? (intent.where === 'between' && parseFloat(ctx.computed.gap) ? ctx.computed.gap : intent.where === 'below' ? ctx.computed['margin-bottom'] : ctx.computed.margin) : ctx.computed[property] || '' },
      target: { ...ctx.target, page_path: app.pagePath },
      viewport_w: window.innerWidth,
    };
    const res = designHint(tokens, request, intent.direction);
    if (!res) { node.hidden = true; return; }
    last = { request, direction: intent.direction, result: res };
    const ok = res.status === 'allowed';
    const tone = res.info ? 'info' : ok ? 'ok' : res.status === 'blocked' ? 'no' : 'warn';
    const check = h('button', { type: 'button', class: 'ds-flag-link' }, 'Request style change');
    check.addEventListener('click', () => onCheck({ element: request.element, property, value: intent.value || (res.value || '') }));
    const view = h('a', { class: 'ds-flag-link', href: designSystemUrlFor(app, request, res), target: '_blank', rel: 'noopener' }, 'View in design system');
    node.className = `ds-flag ds-flag-${tone}`;
    node.replaceChildren(
      h('div', { class: 'ds-flag-h' }, h('b', {}, res.info ? 'Design system' : ok ? 'Fits the design system' : res.status === 'blocked' ? 'Not allowed by the design system' : 'Goes against the design system'), h('span', {}, ` · ${res.rule.label}`)),
      h('div', {}, res.message),
      h('div', { class: 'ds-flag-links' }, ok && !res.value ? null : check, view),
    );
    node.hidden = false;
  }
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 250); });
  return { node, flagged: () => (last && last.result.status !== 'allowed' && !last.result.info ? last : null) };
}

const DONE = {
  applied: 'Applied on staging', task: 'Saved as a ready-to-do change', exception_applied: 'Exception applied',
  exception_logged: 'Exception logged', exception_requested: 'Exception requested', proposal_pending: 'Rule change sent for approval',
  sent_to_team: 'Sent to the team',
};

// ------------------------------------------------------------ status card
const TITLES = {
  flagged: ['warn', 'Goes against the design system'],
  applied: ['ok', 'Applied on staging'],
  task: ['warn', 'Ready to do'],
  exception_applied: ['ok', 'Exception applied'],
  exception_logged: ['warn', 'Exception logged, ready to do'],
  exception_requested: ['warn', 'Exception requested, waiting on approval'],
  exception_rejected: ['no', 'Exception not approved'],
  proposal_pending: ['warn', 'Rule change waiting on approval'],
  approved_applied: ['ok', 'Rule change approved and applied on staging'],
  approved_task: ['warn', 'Rule change approved, ready to do'],
  rejected: ['no', 'Rule change not approved'],
  sent_to_team: ['warn', 'Sent to the team'],
  reverted: ['no', 'Change undone'],
};
export function designCard(app, comment, reopen) {
  const dc = comment.design_check;
  if (!dc || !dc.state) return null;
  let [tone, title] = TITLES[dc.state] || ['warn', dc.state];
  if (dc.state === 'flagged' && dc.result && dc.result.status === 'blocked') [tone, title] = ['no', 'Not allowed by the design system'];
  const r = dc.request || {};
  const da = (app.access && app.access.design_rules) || {};
  const rows = [
    h('div', { class: `ds-badge ds-${tone}` }, h('b', {}, title), dc.approved_version ? h('span', {}, ` · v${dc.approved_version}`) : null),
    h('div', { class: 'ds-sub' }, `${elementLabel(r.element || '')} ${propLabel(r.property || '').toLowerCase()} ${r.value ? `→ ${r.value}` : dc.direction === 'less' ? '· less' : dc.direction === 'more' ? '· more' : ''}`, /^#[0-9a-f]{6}$/i.test(r.value || '') ? h('span', { class: 'ds-swatch ds-inline', style: `background:${r.value}` }) : null),
  ];
  if (dc.result && dc.result.message) rows.push(h('div', { class: 'ds-sub' }, dc.result.message));
  if (dc.scope) rows.push(h('div', { class: 'ds-sub' }, h('b', {}, 'Proposed: '), dc.scope.label));
  if (dc.option && dc.option.summary) rows.push(h('div', { class: 'ds-sub' }, h('b', {}, 'Chosen: '), dc.option.summary));
  if (dc.applied) rows.push(h('div', { class: 'ds-sub' }, h('b', {}, 'Now: '), dc.applied.label || dc.applied.value));
  if (dc.reason) rows.push(h('div', { class: 'ds-sub' }, h('b', {}, 'Reason: '), dc.reason));
  if (dc.task) rows.push(h('div', { class: 'ds-task' }, dc.task));
  if (dc.affected && dc.affected.length) {
    rows.push(h('div', { class: 'ds-sub' }, h('b', {}, `${dc.affected.length} page${dc.affected.length === 1 ? '' : 's'} affected: `)));
    const list = h('ul', { class: 'ds-pages' });
    for (const p of dc.affected.slice(0, 12)) {
      let href = p.preview_url || p.url;
      try { const u = new URL(href); if (app.token) u.searchParams.set('pinpoint', app.token); href = u.toString(); } catch { /* keep */ }
      list.appendChild(h('li', {}, h('a', { href, target: '_blank', rel: 'noopener' }, p.title || p.url), p.preview_url ? ' · preview' : ''));
    }
    rows.push(list);
  }
  const by = dc.state === 'flagged' ? null : dc.approved_by || dc.decided_by;
  if (by) rows.push(h('div', { class: 'ds-sub ds-by' }, `${dc.approved_by ? 'Approved' : 'Chosen'} by ${by}`));

  const act = async (action, btn, done) => {
    btn.disabled = true;
    try {
      const res = await designCall(app, { action, comment_id: comment.id });
      app.comments.set(res.comment.id, res.comment);
      app.designRules = null;
      app.refresh();
      reopen();
      toast(app.ui, done);
    } catch (err) { btn.disabled = false; toast(app.ui, err.message); }
  };
  const actions = h('div', { class: 'ds-actions' });
  if (da.can_approve && (dc.state === 'proposal_pending' || dc.state === 'exception_requested')) {
    const ok = h('button', { type: 'button', class: 'btn btn-teal btn-sm' }, 'Approve');
    const no = h('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, 'Reject');
    ok.addEventListener('click', () => act('approve', ok, 'Approved'));
    no.addEventListener('click', () => act('reject', no, 'Rejected'));
    actions.append(no, ok);
  }
  if (da.can_revert && dc.state === 'applied' && dc.applied && dc.applied.previous) {
    const u = h('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, `Undo (back to ${dc.applied.previous})`);
    u.addEventListener('click', () => act('revert', u, 'Change undone'));
    actions.append(u);
  }
  if (dc.state === 'flagged' && dc.result) {
    rows.push(h('div', { class: 'ds-flag-links' }, h('a', { class: 'ds-flag-link', href: designSystemUrlFor(app, r, dc.result), target: '_blank', rel: 'noopener' }, 'View in design system')));
  }
  if (actions.children.length) rows.push(actions);
  return h('div', { class: `ds-card ds-card-${tone}` }, ...rows);
}
