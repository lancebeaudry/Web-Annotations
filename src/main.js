import { init } from './app.js';

// Activation gate: real visitors short-circuit here. The script runs
// when the URL carries ?markup=TOKEN (data-project on the script tag
// is the fallback token when ?markup is present but empty). Once
// activated, the token is kept in sessionStorage so feedback mode
// survives navigating between pages — it ends when the tab closes or
// via the Exit button.
const script = document.currentScript;
const params = new URLSearchParams(location.search);

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

if (token) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init(token));
  } else {
    init(token);
  }
}
