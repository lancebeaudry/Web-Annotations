// Tiny DOM helpers (same h() as the overlay, src/ui/overlay.js).

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return el;
}

export const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');

export function field(label, input, hint) {
  return h('div', { class: 'field' }, h('label', {}, label), input, hint ? h('div', { class: 'hint' }, hint) : null);
}

// A read-only value with a Copy button.
export function copyBox(value, { multiline = false } = {}) {
  const out = multiline
    ? h('textarea', { class: 'code', readonly: true, rows: '3' })
    : h('input', { class: 'code', readonly: true, value });
  if (multiline) out.value = value;
  const btn = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, 'Copy');
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(value);
      btn.textContent = 'Copied';
      setTimeout(() => (btn.textContent = 'Copy'), 1500);
    } catch {
      out.select();
    }
  });
  return h('div', { class: 'copy-box' }, out, btn);
}

let toastTimer = null;
export function toast(message) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = h('div', { class: 'toast' });
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

export const slugify = (s) =>
  (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
