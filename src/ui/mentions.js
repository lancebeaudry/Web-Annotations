import { listMentionable } from '../data.js';
import { h } from './overlay.js';

// Fetch the project's mentionable roster once and cache it on app.
async function roster(app) {
  if (!app._mentionables) {
    app._mentionables = await listMentionable(app.supabase, app.project.id);
  }
  return app._mentionables; // [{ email, name }]
}

// Resolve a list of mention emails to display names for rendering.
export function mentionLabel(app, email) {
  const hit = (app._mentionables || []).find((p) => p.email === email);
  return hit?.name || email;
}

// Attach an @-autocomplete to a <textarea>. Returns { getMentions() }
// giving the emails the author actually referenced and left in the text.
// The dropdown is mounted into `layer` (the overlay layer) in page coords.
export function attachMentions(app, input, layer) {
  const menu = h('div', { class: 'mention-menu' });
  menu.style.display = 'none';
  layer.appendChild(menu);

  let people = [];
  roster(app).then((r) => { people = r; });

  // Picked mentions, tracked as { label, email }; a mention only counts
  // if its label text is still present at submit time.
  const picked = [];
  let anchor = -1; // index of the '@' being typed

  const close = () => { menu.style.display = 'none'; anchor = -1; };

  // The "@query" immediately left of the caret, if any.
  function query() {
    const pos = input.selectionStart;
    const m = input.value.slice(0, pos).match(/(?:^|\s)@([^\s@]*)$/);
    if (!m) return null;
    return { start: pos - m[1].length - 1, q: m[1].toLowerCase() };
  }

  function position() {
    const r = input.getBoundingClientRect();
    menu.style.left = `${r.left + window.scrollX}px`;
    menu.style.top = `${r.bottom + window.scrollY + 4}px`;
    menu.style.width = `${Math.max(180, r.width)}px`;
  }

  function pick(p) {
    const pos = input.selectionStart;
    const before = input.value.slice(0, anchor);
    const after = input.value.slice(pos);
    const label = p.name || p.email.split('@')[0];
    input.value = `${before}@${label} ${after}`;
    picked.push({ label: `@${label}`, email: p.email });
    const caret = before.length + label.length + 2; // '@' + label + ' '
    close();
    input.focus();
    input.setSelectionRange(caret, caret);
  }

  function update() {
    const cur = query();
    if (!cur) return close();
    anchor = cur.start;
    const matches = people
      .filter((p) =>
        (p.name || '').toLowerCase().includes(cur.q) ||
        p.email.toLowerCase().includes(cur.q))
      .slice(0, 6);
    if (!matches.length) return close();
    menu.replaceChildren(
      ...matches.map((p) =>
        h('button', { type: 'button', class: 'mention-item', onclick: () => pick(p) },
          p.name ? `${p.name} · ${p.email}` : p.email))
    );
    position();
    menu.style.display = 'block';
  }

  input.addEventListener('input', update);
  input.addEventListener('keydown', (e) => {
    if (menu.style.display === 'none') return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Enter') { e.preventDefault(); menu.firstChild?.click(); }
  });
  input.addEventListener('blur', () => setTimeout(close, 150));

  return {
    getMentions() {
      const text = input.value;
      const out = new Set();
      for (const { label, email } of picked) {
        if (text.includes(label)) out.add(email);
      }
      return [...out];
    },
    destroy() { menu.remove(); },
  };
}
