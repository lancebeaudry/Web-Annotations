// "Sign in with PinPoint": opened in a small window by a site's PinPoint
// sign-in card. The person confirms the site; we mint a session for it
// (functions/connect) and hand it back to the site that opened us, addressed
// to its exact origin so no other page can receive it.
import { h } from '../ui/dom.js';
import { card } from '../ui/shell.js';
import { callFn } from '../api.js';

export async function connectScreen({ query = {}, user }) {
  const origin = String(query.origin || '');
  const token = String(query.token || '');
  const opener = window.opener;
  if (!opener || !origin || !token) {
    return card('Sign in with PinPoint', h('p', {}, 'Open this from the PinPoint sign-in card on your site.'));
  }
  let info;
  try { info = await callFn('connect', { action: 'check', origin, token }); }
  catch (e) { return card('Can’t sign in here', h('p', {}, e.message)); }
  if (!info.allowed) {
    return card('Can’t sign in here', h('p', {}, `${info.host} isn’t one of the addresses for ${info.project}.`), h('p', { class: 'hint' }, 'If this is the project’s staging or live site, update the site URL in the project settings, then try again.'));
  }
  const status = h('p', { class: 'hint' });
  const go = h('button', { class: 'btn', type: 'button' }, `Sign in on ${info.host}`);
  const cancel = h('button', { class: 'btn btn-ghost', type: 'button' }, 'Cancel');
  cancel.addEventListener('click', () => window.close());
  go.addEventListener('click', async () => {
    go.disabled = true; cancel.disabled = true;
    status.textContent = 'Signing you in…';
    try {
      const s = await callFn('connect', { action: 'connect', origin, token });
      opener.postMessage({ type: 'pinpoint-connect', access_token: s.access_token, refresh_token: s.refresh_token }, origin);
      status.textContent = 'You’re signed in. This window will close.';
      setTimeout(() => window.close(), 900);
    } catch (e) {
      status.textContent = e.message;
      go.disabled = false; cancel.disabled = false;
    }
  });
  return card('Sign in with PinPoint',
    h('p', {}, 'Sign in to ', h('b', {}, info.project), ' on ', h('b', {}, info.host), ` as ${info.email}?`),
    h('p', { class: 'hint' }, 'Only confirm if you just clicked “Sign in with PinPoint” on that site.'),
    h('div', { class: 'btn-row', style: 'justify-content:flex-start' }, go, cancel),
    status);
}
