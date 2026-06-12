import { CSS } from './styles.js';

// Mount the shadow-DOM overlay. Everything the tool renders lives
// under this one host; client CSS can't reach in, ours can't leak out.
export function mountOverlay() {
  const host = document.createElement('div');
  host.id = 'markup-root';
  host.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:0;z-index:2147483000;';
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = CSS;

  const layer = document.createElement('div');
  layer.className = 'layer';

  const highlight = document.createElement('div');
  highlight.className = 'highlight';

  const pinLayer = document.createElement('div');
  pinLayer.className = 'pin-layer';

  const toast = document.createElement('div');
  toast.className = 'toast';

  layer.append(highlight, pinLayer, toast);
  shadow.append(style, layer);
  document.body.appendChild(host);

  return { host, shadow, layer, highlight, pinLayer, toastEl: toast };
}

let toastTimer = null;
export function toast(ui, message) {
  ui.toastEl.textContent = message;
  ui.toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toastEl.classList.remove('show'), 2600);
}

// Tiny element builder used by all UI modules.
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value);
  }
  for (const child of children) {
    if (child == null) continue;
    el.append(child.nodeType ? child : document.createTextNode(child));
  }
  return el;
}
