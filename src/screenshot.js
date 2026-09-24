// Automatic element screenshots + browser context for new comments.
//
// html2canvas is loaded on demand from cdnjs (only when a comment is saved
// and the project has auto-screenshots on), so the bundle stays small and
// pages that never comment never pay for it. Capture is best-effort: any
// failure (cross-origin images, CSP, timeouts) just means no screenshot.

import { uploadAttachment } from './data.js';

const H2C = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
let loader = null;

function loadHtml2Canvas() {
  if (window.html2canvas) return Promise.resolve(window.html2canvas);
  if (!loader) {
    loader = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = H2C;
      s.async = true;
      s.onload = () => (window.html2canvas ? resolve(window.html2canvas) : reject(new Error('html2canvas missing')));
      s.onerror = () => reject(new Error('html2canvas failed to load'));
      document.head.appendChild(s);
    });
  }
  return loader;
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

// Capture the area around `el` (element box + margin, clipped to the page)
// and upload it as a PNG attachment. Returns {url, name, type, auto} or null.
export async function captureElementScreenshot(app, el) {
  try {
    const html2canvas = await withTimeout(loadHtml2Canvas(), 6000);
    const r = el.getBoundingClientRect();
    const pad = 48;
    const docW = document.documentElement.scrollWidth;
    const docH = document.documentElement.scrollHeight;
    const x = Math.max(0, Math.floor(r.left + window.scrollX - pad));
    const y = Math.max(0, Math.floor(r.top + window.scrollY - pad));
    const width = Math.min(docW - x, Math.ceil(Math.max(r.width, 240) + pad * 2), 1600);
    const height = Math.min(docH - y, Math.ceil(Math.max(r.height, 120) + pad * 2), 1200);
    if (width < 20 || height < 20) return null;
    const canvas = await withTimeout(
      html2canvas(document.body, {
        x, y, width, height,
        scrollX: 0, scrollY: 0,
        windowWidth: document.documentElement.clientWidth,
        useCORS: true,
        logging: false,
        scale: Math.min(2, window.devicePixelRatio || 1),
        ignoreElements: (n) => n.id === 'markup-root',
      }),
      12000
    );
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    if (!blob) return null;
    const file = new File([blob], 'screenshot.png', { type: 'image/png' });
    const up = await uploadAttachment(app.supabase, app.project.id, file);
    return up ? { ...up, name: 'Auto screenshot', auto: true } : null;
  } catch (e) {
    console.warn('[pinpoint] auto screenshot skipped:', e && e.message);
    return null;
  }
}

// Console/network error capture. Installed once at startup; keeps the last
// few errors so a bug report carries what the reviewer saw in devtools.
export function installErrorLog(app) {
  const log = (app.errorLog = app.errorLog || []);
  const push = (kind, msg) => {
    log.push({ kind, msg: String(msg).slice(0, 300), at: new Date().toISOString() });
    if (log.length > 15) log.shift();
  };
  window.addEventListener('error', (e) => push('error', e.message || (e.error && e.error.message) || 'error'));
  window.addEventListener('unhandledrejection', (e) => push('rejection', (e.reason && (e.reason.message || e.reason)) || 'rejection'));
  const orig = console.error;
  console.error = function (...args) {
    try { push('console', args.map((a) => (a && a.message) || (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); } catch { /* ignore */ }
    return orig.apply(this, args);
  };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.responseStatus && e.responseStatus >= 400) push('request', `${e.responseStatus} ${e.name}`);
    }).observe({ type: 'resource', buffered: true });
  } catch { /* no responseStatus support */ }
}

export function collectContext(app) {
  const ua = navigator.userAgent || '';
  const os = /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return {
    browser, os, ua: ua.slice(0, 200),
    viewport: [window.innerWidth, window.innerHeight],
    dpr: window.devicePixelRatio || 1,
    lang: navigator.language,
    url: location.href.split('#')[0].replace(/([?&])markup=[^&]*/, '$1').replace(/[?&]$/, ''),
    errors: (app.errorLog || []).slice(-10),
  };
}

export function contextSummary(ctx) {
  if (!ctx) return '';
  const bits = [];
  if (ctx.browser || ctx.os) bits.push([ctx.browser, ctx.os].filter(Boolean).join(' on '));
  if (ctx.viewport) bits.push(`${ctx.viewport[0]}×${ctx.viewport[1]}${ctx.dpr && ctx.dpr !== 1 ? ` @${ctx.dpr}x` : ''}`);
  const n = (ctx.errors || []).length;
  if (n) bits.push(`${n} console error${n === 1 ? '' : 's'}`);
  return bits.join(' · ');
}
