import { h, field, toast } from '../ui/dom.js';
import { card } from '../ui/shell.js';
import { supabase } from '../api.js';
import { DASHBOARD_URL } from '../config.js';

// Email -> one-time code. Same flow as the overlay (src/ui/auth.js). Codes
// need no redirect allowlist; the magic link in the same email works after
// the one-time allowlist entry for DASHBOARD_URL.
export function signinScreen() {
  const email = h('input', { type: 'email', placeholder: 'you@example.com', required: true, autocomplete: 'email' });
  const submit = h('button', { class: 'btn', type: 'submit' }, 'Email me a sign-in code');
  const form = h(
    'form',
    {},
    h('p', {}, 'Sign in or create your account — no password, just a code we email you.'),
    field('Email', email),
    h('div', { class: 'btn-row' }, submit)
  );
  const body = h('div', {}, form);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = email.value.trim();
    if (!v) return;
    submit.disabled = true;
    submit.textContent = 'Sending…';
    const { error } = await supabase.auth.signInWithOtp({ email: v, options: { shouldCreateUser: true, emailRedirectTo: DASHBOARD_URL } });
    if (error) {
      submit.disabled = false;
      submit.textContent = 'Email me a sign-in code';
      toast(`Could not send: ${error.message}`);
      return;
    }
    codeStep(body, v);
  });

  return h('div', { class: 'auth' }, card('Sign in', body));
}

function codeStep(body, email) {
  const code = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '8', placeholder: '123456' });
  const verify = h('button', { class: 'btn', type: 'submit' }, 'Verify');
  const back = h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => location.reload() }, 'Use a different email');
  const form = h(
    'form',
    {},
    h('p', {}, 'We emailed a code to ', h('b', {}, email), '. Enter it below, or click the link in that email.'),
    field('Sign-in code', code),
    h('div', { class: 'btn-row' }, back, verify)
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = code.value.trim();
    if (token.length < 4) return;
    verify.disabled = true;
    let { error } = await supabase.auth.verifyOtp({ email, token, type: 'email' });
    if (error) ({ error } = await supabase.auth.verifyOtp({ email, token, type: 'signup' }));
    if (error) {
      verify.disabled = false;
      toast("That code didn't match — try again.");
      return;
    }
    // onAuthStateChange in main.js re-routes.
  });
  body.replaceChildren(form);
  code.focus();
}
