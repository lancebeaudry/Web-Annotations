import { h, toast } from './overlay.js';

const NAME_KEY = 'markup_author_name';

export function savedName() {
  try {
    return localStorage.getItem(NAME_KEY) || '';
  } catch {
    return '';
  }
}

// Email-capture mini-form -> Supabase magic link. The redirect comes
// back to this exact URL (keeping ?markup=TOKEN) so the session lands
// right back in the overlay.
export function renderAuthCard(app) {
  const { ui } = app;

  const nameInput = h('input', { type: 'text', placeholder: 'Sarah', value: savedName() });
  const emailInput = h('input', { type: 'email', placeholder: 'you@example.com', required: 'true' });
  const submit = h('button', { class: 'btn', type: 'submit' }, 'Email me a sign-in link');

  const form = h(
    'form',
    {},
    h('p', { class: 'hint' }, 'Sign in once and you can click anywhere on the page to leave feedback.'),
    h('div', { class: 'field' }, h('label', {}, 'Your name'), nameInput),
    h('div', { class: 'field' }, h('label', {}, 'Email'), emailInput),
    h('div', { class: 'btn-row' }, submit)
  );

  const card = h(
    'div',
    { class: 'card auth-card' },
    h('div', { class: 'card-head' }, `Feedback · ${document.location.hostname}`),
    h('div', { class: 'card-body' }, form)
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
      submit.textContent = 'Email me a sign-in link';
      toast(ui, `Could not send link: ${error.message}`);
      return;
    }
    form.replaceChildren(
      h('p', {}, h('b', {}, 'Check your email.'), ` We sent a sign-in link to ${email}. Open it on this device and you'll come right back here.`)
    );
  });

  ui.layer.appendChild(card);
  app.authCard = card;
}

export function removeAuthCard(app) {
  if (app.authCard) {
    app.authCard.remove();
    app.authCard = null;
  }
}
