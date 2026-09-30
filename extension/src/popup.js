// PinPoint Anywhere — toolbar popup: sign in, set your name, start picking.
//
// Chrome closes this popup whenever you click away (for example, to go and
// read the emailed code), so nothing here may live only in memory. The
// pending sign-in (email + when the code was sent) is kept in storage and
// the popup reopens on the code field.
const $ = (id) => document.getElementById(id);
const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));
const store = chrome.storage.local;
const PENDING_TTL = 15 * 60 * 1000; // codes last 10 minutes; keep the field a little longer

const getPending = async () => {
  const { pp_pending: p } = await store.get('pp_pending');
  return p && Date.now() - p.at < PENDING_TTL ? p : null;
};

function showCodeStep(email) {
  $('emailStep').classList.add('hidden');
  $('codeStep').classList.remove('hidden');
  $('sentTo').textContent = email;
  $('code').focus();
}
function showEmailStep(email) {
  $('codeStep').classList.add('hidden');
  $('emailStep').classList.remove('hidden');
  if (email) $('email').value = email;
  $('email').focus();
}

async function render() {
  const s = await send({ type: 'status' });
  const signedIn = !!(s && s.signedIn);
  $('signin').classList.toggle('hidden', signedIn);
  $('app').classList.toggle('hidden', !signedIn);
  if (signedIn) {
    await store.remove(['pp_pending', 'pp_email_draft']);
    $('whoEmail').textContent = s.email;
    $('name').value = s.name || '';
    return;
  }
  const pending = await getPending();
  if (pending) return showCodeStep(pending.email);
  const { pp_email_draft: draft } = await store.get('pp_email_draft');
  showEmailStep(draft || '');
}

async function sendCode(email) {
  $('err1').textContent = '';
  const r = await send({ type: 'sendCode', email });
  if (!r.ok) { $('err1').textContent = r.error; return false; }
  await store.set({ pp_pending: { email, at: Date.now() } });
  showCodeStep(email);
  return true;
}

$('email').addEventListener('input', () => store.set({ pp_email_draft: $('email').value.trim() }));
$('send').addEventListener('click', async () => {
  const email = $('email').value.trim().toLowerCase();
  if (!email) return ($('err1').textContent = 'Enter your email.');
  $('send').disabled = true;
  await sendCode(email);
  $('send').disabled = false;
});
$('email').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('send').click(); });

async function verify() {
  const pending = await getPending();
  const code = $('code').value.replace(/\D/g, '');
  if (!pending) return showEmailStep('');
  if (code.length < 6) return ($('err1').textContent = 'Enter the 6-digit code from the email.');
  $('verify').disabled = true; $('err1').textContent = '';
  const r = await send({ type: 'verify', email: pending.email, code });
  $('verify').disabled = false;
  if (!r.ok) return ($('err1').textContent = r.error);
  render();
}
$('verify').addEventListener('click', verify);
$('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') verify(); });
// Pasting or typing the sixth digit signs in without another click.
$('code').addEventListener('input', () => { if ($('code').value.replace(/\D/g, '').length === 6) verify(); });

$('resend').addEventListener('click', async () => {
  const pending = await getPending();
  if (!pending) return showEmailStep('');
  $('resend').textContent = 'Sending…';
  const ok = await sendCode(pending.email);
  $('resend').textContent = ok ? 'Sent again' : 'Resend code';
  setTimeout(() => { $('resend').textContent = 'Resend code'; }, 2500);
});
$('change').addEventListener('click', async () => {
  const pending = await getPending();
  await store.remove('pp_pending');
  $('err1').textContent = '';
  showEmailStep(pending ? pending.email : '');
});

$('signout').addEventListener('click', async () => { await send({ type: 'signOut' }); render(); });
let nameTimer;
$('name').addEventListener('input', () => { clearTimeout(nameTimer); nameTimer = setTimeout(() => send({ type: 'setName', name: $('name').value }), 300); });
$('pick').addEventListener('click', async () => {
  await send({ type: 'setName', name: $('name').value });
  const r = await send({ type: 'startPicker' });
  if (!r.ok) return ($('err2').textContent = r.error);
  window.close();
});
render();
