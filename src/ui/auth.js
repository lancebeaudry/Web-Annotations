import { h, toast } from './overlay.js';

const NAME_KEY = 'markup_author_name';

export function savedName() {
  try {
    return localStorage.getItem(NAME_KEY) || '';
  } catch {
    return '';
  }
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

  const form = h(
    'form',
    {},
    h('p', { class: 'hint' }, 'Sign in once and you can click anywhere on the page to leave feedback.'),
    h('div', { class: 'field' }, h('label', {}, 'Your name'), nameInput),
    h('div', { class: 'field' }, h('label', {}, 'Email'), emailInput),
    h('div', { class: 'btn-row' }, submit)
  );

  const body = h('div', { class: 'card-body' }, form);
  const card = h(
    'div',
    { class: 'card auth-card' },
    h('div', { class: 'card-head' }, `Feedback · ${document.location.hostname}`),
    body
  );

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

// Second step: enter the 6-digit code from the email.
function renderCodeStep(app, body, email) {
  const { ui } = app;

  const codeInput = h('input', {
    type: 'text',
    inputmode: 'numeric',
    autocomplete: 'one-time-code',
    maxlength: '6',
    placeholder: '123456',
  });
  const verify = h('button', { class: 'btn', type: 'submit' }, 'Verify & start');
  const back = h('button', { class: 'btn btn-ghost', type: 'button' }, 'Use a different email');

  const form = h(
    'form',
    {},
    h('p', {}, 'We emailed a 6-digit code to ', h('b', {}, email), '. Enter it below — or just click the link in that email.'),
    h('div', { class: 'field' }, h('label', {}, 'Sign-in code'), codeInput),
    h('div', { class: 'btn-row' }, back, verify)
  );

  back.addEventListener('click', () => {
    removeAuthCard(app);
    renderAuthCard(app);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = codeInput.value.trim();
    if (token.length < 6) return;
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

export function removeAuthCard(app) {
  if (app.authCard) {
    app.authCard.remove();
    app.authCard = null;
  }
}
