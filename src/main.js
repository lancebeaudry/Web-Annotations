import { init } from './app.js';

// Activation gate: real visitors short-circuit here. The script runs
// when the URL carries ?markup=TOKEN (data-project on the script tag
// is the fallback token when ?markup is present but empty). Once
// activated, the token is kept in sessionStorage so feedback mode
// survives navigating between pages — it ends when the tab closes or
// via the Exit button.
const script = document.currentScript;
const params = new URLSearchParams(location.search);

// data-open="1" means the plugin's "open feedback" toggle is on: visitors
// who aren't signed in can comment after entering just a display name.
// Captured here because document.currentScript is only valid during this
// synchronous pass.
const openAccess = !!(script && script.dataset.open);

let token = null;
if (params.has('markup')) {
  token = params.get('markup') || (script && script.dataset.project) || '';
  try {
    if (token) sessionStorage.setItem('markup_token', token);
  } catch {
    /* storage blocked — single-page activation still works */
  }
} else {
  try {
    token = sessionStorage.getItem('markup_token');
  } catch {
    token = null;
  }
}

// Double-include guard: if the embed ends up in both a theme and the
// plugin, only the first copy mounts.
if (token && !window.__avalancheMarkup) {
  window.__avalancheMarkup = true;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init(token, { openAccess }));
  } else {
    init(token, { openAccess });
  }
}
