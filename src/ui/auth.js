import { h, toast } from './overlay.js';
import { brandMark, poweredBy } from './brand.js';
import { DASHBOARD_URL, SUPABASE_URL } from '../config.js';

const NAME_KEY = 'markup_author_name';

export function savedName() {
  try {
    return localStorage.getItem(NAME_KEY) || '';
  } catch {
    return '';
  }
}

// Card header: "Feedback · host" with the Avalanche mark.
// Mock builds may override the shown host (?mockHost=) for screenshots.
function shownHost() {
  if (SUPABASE_URL.startsWith('mock://')) {
    const h = new URLSearchParams(location.search).get('mockHost');
    if (h) return h;
  }
  return document.location.hostname;
}
function cardHead(text) {
  return h('div', { class: 'card-head' }, h('span', {}, text), brandMark(14));
}

// Email sign-in. We send a one-time code AND a magic link (the email
// contains both). Typing the code is the reliable path — corporate
// email link-scanners silently consume single-use links before the
// human clicks, but they can't "click" a code. Clicking the link still
// works too (detectSessionInUrl handles the redirect in app.js).
export function renderAuthCard(app) {
  const { ui } = app;

  const nameInput = h('input', { type: 'text', placeholder: 'Sarah', value: savedName() });
  const emailInput = h('input', { type: 'email', placeholder: 'you@example.com', required: 'true' });
  const submit = h('button', { class: 'btn', type: 'submit' }, 'Email me a sign-in code');

  // One click when you're already signed in to the PinPoint dashboard.
  const withPinPoint = h('button', { class: 'btn btn-ghost pp-connect', type: 'button' }, brandMark(14), h('span', {}, 'Sign in with PinPoint'));
  withPinPoint.addEventListener('click', () => connectWithPinPoint(app, withPinPoint));

  const form = h(
    'form',
    {},
    h('p', { class: 'hint' }, 'Sign in once and you can click anywhere on the page to leave feedback.'),
    withPinPoint,
    h('div', { class: 'or-rule' }, h('span', {}, 'or use your email')),
    h('div', { class: 'field' }, h('label', {}, 'Your name'), nameInput),
    h('div', { class: 'field' }, h('label', {}, 'Email'), emailInput),
    h('div', { class: 'btn-row' }, submit),
    h(
      'p',
      { class: 'hint auth-foot' },
      'New here? ',
      h('a', { href: DASHBOARD_URL, target: '_blank', rel: 'noopener' }, 'Create a free account')
    )
  );

  const body = h('div', { class: 'card-body' }, form);
  const card = h('div', { class: 'card auth-card' }, cardHead(`Feedback · ${shownHost()}`), body, poweredBy('card'));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = emailInput.value.trim();
    if (!email) return;
    try {
      localStorage.setItem(NAME_KEY, nameInput.value.trim());
    } catch {
      /* storage blocked — name is optional */
    }
    submit.disabled = true;
    submit.textContent = 'Sending…';
    const { error } = await app.supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: location.href },
    });
    if (error) {
      submit.disabled = false;
      submit.textContent = 'Email me a sign-in code';
      toast(ui, `Could not send: ${error.message}`);
      return;
    }
    renderCodeStep(app, body, email);
  });

  ui.layer.appendChild(card);
  app.authCard = card;
}

// Second step: enter the code from the email (6 digits; older mail
// templates sent 8, so the field accepts either).
function renderCodeStep(app, body, email) {
  const { ui } = app;

  const codeInput = h('input', {
    type: 'text',
    inputmode: 'numeric',
    autocomplete: 'one-time-code',
    maxlength: '8',
    placeholder: '123456',
  });
  const verify = h('button', { class: 'btn', type: 'submit' }, 'Verify & start');
  const back = h('button', { class: 'btn btn-ghost', type: 'button' }, 'Use a different email');

  const form = h(
    'form',
    {},
    h('p', {}, 'We emailed a code to ', h('b', {}, email), '. Enter it below — or just click the link in that email.'),
    h('div', { class: 'field' }, h('label', {}, 'Sign-in code'), codeInput),
    h('div', { class: 'btn-row' }, verify, back)
  );

  back.addEventListener('click', () => {
    removeAuthCard(app);
    renderAuthCard(app);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = codeInput.value.trim();
    if (token.length < 4) return;
    verify.disabled = true;
    verify.textContent = 'Verifying…';
    // New users come through as a 'signup' OTP, existing users as 'email';
    // try the common case first, then fall back so both just work.
    let { error } = await app.supabase.auth.verifyOtp({ email, token, type: 'email' });
    if (error) {
      ({ error } = await app.supabase.auth.verifyOtp({ email, token, type: 'signup' }));
    }
    if (error) {
      verify.disabled = false;
      verify.textContent = 'Verify & start';
      toast(ui, "That code didn't match — double-check and try again.");
      return;
    }
    // Success: onAuthStateChange in app.js picks up the session and starts.
  });

  body.replaceChildren(form);
  codeInput.focus();
}

// Guest entry for "open feedback" sites: no email, no code — just a
// display name, then an anonymous Supabase session. The name is the only
// attribution we get, so it's required (RLS enforces it server-side too).
export function renderGuestCard(app) {
  const { ui } = app;

  const nameInput = h('input', { type: 'text', placeholder: 'Sarah', value: savedName(), required: 'true' });
  const submit = h('button', { class: 'btn', type: 'submit' }, 'Start commenting');
  const accountLink = h('button', { class: 'btn btn-ghost', type: 'button' }, 'Have an account? Sign in');

  const form = h(
    'form',
    {},
    h('p', { class: 'hint' }, 'Add your name so the team knows whose feedback is whose, then click anywhere on the page to comment.'),
    h('div', { class: 'field' }, h('label', {}, 'Your name'), nameInput),
    h('div', { class: 'btn-row' }, submit, accountLink)
  );

  const card = h(
    'div',
    { class: 'card auth-card' },
    cardHead(`Feedback · ${shownHost()}`),
    h('div', { class: 'card-body' }, form),
    poweredBy('card')
  );

  // Owners, collaborators and staff need the email path to get their role.
  accountLink.addEventListener('click', () => {
    removeAuthCard(app);
    renderAuthCard(app);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) {
      toast(ui, 'Please enter your name first');
      return;
    }
    try {
      localStorage.setItem(NAME_KEY, name);
    } catch {
      /* storage blocked — the name still rides along on this session */
    }
    submit.disabled = true;
    submit.textContent = 'Starting…';
    const { error } = await app.supabase.auth.signInAnonymously();
    if (error) {
      submit.disabled = false;
      submit.textContent = 'Start commenting';
      toast(ui, `Could not start: ${error.message}`);
      return;
    }
    // Success: onAuthStateChange in app.js picks up the session and starts.
  });

  ui.layer.appendChild(card);
  app.authCard = card;
}

// Opens the dashboard's #/connect page in a small window. If the person is
// signed in there and confirms this site, it posts back a session minted for
// this site; we only accept it from the dashboard's own origin and from the
// window we opened.
function connectWithPinPoint(app, btn) {
  const dash = new URL(DASHBOARD_URL);
  dash.hash = `#/connect?origin=${encodeURIComponent(location.origin)}&token=${encodeURIComponent(app.token || '')}`;
  const pop = window.open(dash.toString(), 'pinpoint-connect', 'popup,width=480,height=620');
  if (!pop) return toast(app.ui, 'Allow pop-ups for this site, then try again.');
  btn.disabled = true;
  const done = () => { window.removeEventListener('message', onMsg); clearInterval(watch); btn.disabled = false; };
  async function onMsg(e) {
    if (e.origin !== dash.origin || e.source !== pop) return;
    const d = e.data || {};
    if (d.type !== 'pinpoint-connect' || !d.access_token || !d.refresh_token) return;
    done();
    const { error } = await app.supabase.auth.setSession({ access_token: d.access_token, refresh_token: d.refresh_token });
    if (error) toast(app.ui, 'Couldn’t sign you in. Use your email instead.');
    // Success: onAuthStateChange in app.js picks up the session and starts.
  }
  window.addEventListener('message', onMsg);
  // Re-enable the button if the window is closed without signing in.
  const watch = setInterval(() => { if (pop.closed) done(); }, 700);
}

export function removeAuthCard(app) {
  if (app.authCard) {
    app.authCard.remove();
    app.authCard = null;
  }
}
