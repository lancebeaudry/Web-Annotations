// PinPoint Anywhere — content script.
//
// Injected on demand. Hover to highlight, click to pick an element; the
// service worker takes the tab screenshot, we crop it to the element, and a
// panel collects the note, project and labels. Everything lives in a
// shadow root so the host page's CSS can't touch it.

import { capture } from '../../src/capture.js';

if (!window.__ppPicker) {
  window.__ppPicker = true;

  const LABELS = [['design', 'Design'], ['copy', 'Copy'], ['bug', 'Bug'], ['content', 'Content'], ['photo', 'Photo'], ['decision', 'Decision']];
  const STYLE_KEYS = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textTransform', 'color', 'backgroundColor', 'backgroundImage', 'padding', 'borderRadius', 'border', 'boxShadow', 'gap', 'display', 'maxWidth'];
  const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));

  const css = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
    .hl { position: fixed; pointer-events: none; z-index: 2147483646; border: 2px solid #1B6493; background: rgba(27,100,147,.10); border-radius: 3px; transition: all .04s; }
    .tag { position: fixed; z-index: 2147483647; pointer-events: none; background: #00263D; color: #fff; font-size: 11px; padding: 3px 7px; border-radius: 4px; }
    .hint { position: fixed; left: 50%; top: 14px; transform: translateX(-50%); z-index: 2147483647; background: #00263D; color: #fff; font-size: 13px; padding: 8px 14px; border-radius: 999px; box-shadow: 0 6px 20px rgba(0,0,0,.25); }
    .panel { position: fixed; top: 16px; right: 16px; width: 380px; max-height: calc(100vh - 32px); overflow: auto; z-index: 2147483647; background: #fff; color: #1F2A33; border-radius: 12px; box-shadow: 0 20px 60px rgba(0,38,61,.35); font-size: 14px; }
    .head { background: #00263D; color: #fff; padding: 12px 14px; font-weight: 600; display: flex; justify-content: space-between; align-items: center; cursor: move; }
    .head button { background: transparent; border: 0; color: #fff; font-size: 16px; cursor: pointer; }
    .body { padding: 14px; display: flex; flex-direction: column; gap: 10px; }
    .shot { border: 1px solid #DCE4EB; border-radius: 8px; overflow: hidden; background: #F7F9FB; }
    .shot img { display: block; width: 100%; height: auto; max-height: 220px; object-fit: contain; }
    .src { font-size: 12px; color: #5A6F80; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    textarea, select, input { width: 100%; font: inherit; font-size: 14px; padding: 8px 10px; border: 1px solid #DCE4EB; border-radius: 8px; background: #fff; color: #1F2A33; }
    textarea { min-height: 72px; resize: vertical; }
    textarea:focus, select:focus { outline: none; border-color: #1B6493; box-shadow: 0 0 0 3px rgba(27,100,147,.15); }
    label { font-size: 12px; font-weight: 600; color: #00263D; display: block; margin-bottom: 4px; }
    .chips { display: flex; flex-wrap: wrap; gap: 4px; }
    .chip { font-size: 11px; font-weight: 600; padding: 3px 9px; border-radius: 999px; border: 1px solid #DCE4EB; background: #fff; color: #5A6F80; cursor: pointer; }
    .chip.on { background: #1B6493; border-color: #1B6493; color: #fff; }
    .row { display: flex; gap: 8px; justify-content: flex-end; align-items: center; }
    .btn { font: inherit; font-size: 14px; font-weight: 600; padding: 8px 14px; border-radius: 8px; border: 1px solid #1B6493; background: #1B6493; color: #fff; cursor: pointer; }
    .btn.ghost { background: #fff; color: #00263D; border-color: #C9D6DE; }
    .btn:disabled { opacity: .6; cursor: default; }
    .err { color: #B3392B; font-size: 13px; }
    .styles { font-size: 11px; color: #5A6F80; font-family: ui-monospace, Menlo, monospace; white-space: pre-wrap; max-height: 90px; overflow: auto; background: #F7F9FB; border-radius: 6px; padding: 6px 8px; }
    .ok { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 2147483647; background: #0f6b4f; color: #fff; padding: 10px 16px; border-radius: 10px; font-size: 14px; box-shadow: 0 8px 24px rgba(0,0,0,.25); }
  `;

  let root, shadow, hl, tag, hint, panel;
  function mount() {
    if (root) return;
    root = document.createElement('div');
    root.id = 'pp-anywhere-root';
    shadow = root.attachShadow({ mode: 'open' });
    const style = document.createElement('style'); style.textContent = css;
    hl = el('div', 'hl'); tag = el('div', 'tag'); hint = el('div', 'hint', 'Click the element you want to save · Esc to cancel');
    hl.style.display = tag.style.display = 'none';
    shadow.append(style, hl, tag, hint);
    document.documentElement.appendChild(root);
  }
  function el(t, cls, text) { const e = document.createElement(t); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function unmount() { if (root) root.remove(); root = shadow = hl = tag = hint = panel = null; }

  // ---- pick mode
  let picking = false;
  function targetAt(e) {
    const t = e.composedPath ? e.composedPath()[0] : e.target;
    if (!t || t === root || root.contains(t) || t === document.documentElement || t === document.body) return null;
    return t.nodeType === 1 ? t : t.parentElement;
  }
  function onMove(e) {
    const t = targetAt(e);
    if (!t) { hl.style.display = tag.style.display = 'none'; return; }
    const r = t.getBoundingClientRect();
    Object.assign(hl.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    tag.textContent = `<${t.tagName.toLowerCase()}>${t.id ? '#' + t.id : ''} · ${Math.round(r.width)}×${Math.round(r.height)}`;
    Object.assign(tag.style, { display: 'block', left: `${Math.max(4, r.left)}px`, top: `${Math.max(4, r.top - 22)}px` });
  }
  function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); stopPick(); unmount(); } }
  async function onClick(e) {
    const t = targetAt(e);
    if (!t) return;
    e.preventDefault(); e.stopPropagation();
    stopPick();
    await picked(t);
  }
  function startPick() {
    mount();
    picking = true;
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
  }
  function stopPick() {
    picking = false;
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    if (hl) hl.style.display = tag.style.display = 'none';
    if (hint) hint.style.display = 'none';
  }

  // ---- capture + crop
  async function cropShot(rect) {
    const { dataUrl, error } = await send({ type: 'capture' });
    if (!dataUrl) throw new Error(error || 'Could not take the screenshot');
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = dataUrl; });
    const scale = img.width / window.innerWidth; // handles device pixel ratio and zoom
    const pad = 8;
    const x = Math.max(0, rect.left - pad), y = Math.max(0, rect.top - pad);
    const w = Math.min(window.innerWidth, rect.right + pad) - x, h = Math.min(window.innerHeight, rect.bottom + pad) - y;
    if (w <= 0 || h <= 0) throw new Error('Scroll the element into view first');
    const c = document.createElement('canvas');
    const outScale = Math.min(1, 1600 / (w * scale));
    c.width = Math.round(w * scale * outScale); c.height = Math.round(h * scale * outScale);
    c.getContext('2d').drawImage(img, x * scale, y * scale, w * scale, h * scale, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  }
  function refStyles(node) {
    const cs = getComputedStyle(node); const out = {};
    for (const k of STYLE_KEYS) { const v = cs[k]; if (v && v !== 'none' && v !== 'normal' && v !== '0px' && v !== 'rgba(0, 0, 0, 0)') out[k] = v; }
    return out;
  }

  async function picked(node) {
    const rect = node.getBoundingClientRect();
    let shot;
    try { shot = await cropShot(rect); }
    catch (err) { showPanel(null, node, rect, err.message); return; }
    showPanel(shot, node, rect, null);
  }

  // ---- panel
  function showPanel(shot, node, rect, error) {
    if (panel) panel.remove();
    const cap = capture(node);
    const styles = refStyles(node);
    const source = {
      url: location.href.split('#')[0], title: document.title.slice(0, 160), host: location.host,
      selector: cap.selector, element_tag: cap.element_tag, text: cap.current_text, styles,
      size: [Math.round(rect.width), Math.round(rect.height)],
    };
    panel = el('div', 'panel');
    const head = el('div', 'head'); head.append(el('span', null, 'Save to PinPoint'));
    const close = el('button', null, '✕'); close.addEventListener('click', () => unmount()); head.appendChild(close);
    const body = el('div', 'body');
    if (shot) { const s = el('div', 'shot'); const im = document.createElement('img'); im.src = shot; s.appendChild(im); body.appendChild(s); }
    const src = el('div', 'src', `From ${location.host} · <${cap.element_tag}>${cap.current_text ? ' · “' + cap.current_text.slice(0, 60) + '”' : ''}`);
    body.appendChild(src);
    const err = el('div', 'err', error || ''); body.appendChild(err);

    const note = document.createElement('textarea'); note.placeholder = 'What do you like about this, and for which page? e.g. “This hero layout for the Gordon Water homepage”';
    body.append(labelled('Note', note));
    const proj = document.createElement('select'); proj.appendChild(new Option('Loading your projects…', ''));
    body.append(labelled('Project', proj));
    const chips = el('div', 'chips'); const on = new Set(['design']);
    for (const [k, t] of LABELS) { const c = el('button', 'chip' + (on.has(k) ? ' on' : ''), t); c.type = 'button'; c.addEventListener('click', () => { on.has(k) ? on.delete(k) : on.add(k); c.classList.toggle('on', on.has(k)); }); chips.appendChild(c); }
    body.append(labelled('Labels', chips));
    const det = document.createElement('details'); const sum = document.createElement('summary'); sum.textContent = 'Captured styles'; sum.style.cssText = 'font-size:12px;color:#1B6493;cursor:pointer';
    const pre = el('div', 'styles', Object.entries(styles).map(([k, v]) => `${k}: ${v}`).join('\n') || '(none)'); det.append(sum, pre); body.appendChild(det);
    const row = el('div', 'row');
    const cancel = el('button', 'btn ghost', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', () => unmount());
    const save = el('button', 'btn', 'Save reference'); save.type = 'button'; save.disabled = !shot;
    row.append(cancel, save); body.appendChild(row);
    panel.append(head, body); shadow.appendChild(panel);
    drag(panel, head);
    note.focus();

    send({ type: 'projects' }).then((r) => {
      proj.replaceChildren();
      if (!r || !r.ok) { err.textContent = (r && r.error) || 'Could not load projects'; proj.appendChild(new Option('—', '')); return; }
      if (!r.projects.length) { err.textContent = 'You have no projects yet. Create one in the PinPoint dashboard.'; }
      for (const p of r.projects) proj.appendChild(new Option(p.name, p.id));
      if (r.last && r.projects.some((p) => p.id === r.last)) proj.value = r.last;
    });

    save.addEventListener('click', async () => {
      const text = note.value.trim();
      if (!text) { err.textContent = 'Add a short note so your team knows why this matters.'; note.focus(); return; }
      if (!proj.value) { err.textContent = 'Pick a project.'; return; }
      save.disabled = true; save.textContent = 'Saving…'; err.textContent = '';
      const r = await send({ type: 'save', payload: { project_id: proj.value, note: text, labels: [...on], screenshot: shot, source, viewport_w: window.innerWidth } });
      if (!r || !r.ok) { err.textContent = (r && r.error) || 'Save failed'; save.disabled = false; save.textContent = 'Save reference'; return; }
      panel.remove(); panel = null;
      const ok = el('div', 'ok', `Saved to ${r.project}. Attach it to an element from the PinPoint sidebar on your site.`);
      shadow.appendChild(ok);
      setTimeout(() => unmount(), 3200);
    });
  }
  function labelled(text, control) { const w = document.createElement('div'); const l = el('label', null, text); w.append(l, control); return w; }
  function drag(box, handle) {
    let s = null;
    handle.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) return; s = { x: e.clientX, y: e.clientY, r: box.getBoundingClientRect() }; handle.setPointerCapture(e.pointerId); });
    handle.addEventListener('pointermove', (e) => { if (!s) return; box.style.right = 'auto'; box.style.left = `${s.r.left + e.clientX - s.x}px`; box.style.top = `${s.r.top + e.clientY - s.y}px`; });
    handle.addEventListener('pointerup', () => { s = null; });
  }

  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg.type === 'pp-start') { if (!picking) { unmount(); startPick(); } reply({ ok: true }); }
  });
}
