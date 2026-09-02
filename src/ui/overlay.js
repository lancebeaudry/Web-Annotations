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
  keepMounted(host);

  return { host, shadow, layer, highlight, pinLayer, toastEl: toast };
}

// Keep-alive: some client-rendered apps (single-file design/prototype
// exports, SPAs that hydrate the whole page) rebuild the document on
// startup — swapping <body> or even <html>'s children — which silently
// orphans anything that was there first, our host included. That looked
// like "the overlay appeared for a second, then vanished". Everything we
// render lives in the shadow root ON this one element, so simply
// re-appending it to whatever <body> is live restores the full UI and its
// state intact. Watch the Document node (it outlives a documentElement
// swap) and re-attach whenever the host is no longer connected; a slow
// interval backs that up in case a rewrite path slips past the observer.
// Cost on a quiet page: one boolean check per mutation batch.
function keepMounted(host) {
  const reattach = () => {
    if (host.isConnected) return;
    const body = document.body; // resolve live — it may be a NEW body
    if (body) body.appendChild(host);
  };
  try {
    new MutationObserver(reattach).observe(document, { childList: true, subtree: true });
  } catch {
    /* no MutationObserver — the interval below still covers us */
  }
  setInterval(reattach, 1000);
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
