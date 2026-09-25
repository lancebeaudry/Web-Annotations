// PinPoint Anywhere — toolbar popup: sign in, set your name, start picking.
const $ = (id) => document.getElementById(id);
const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));

async function render() {
  const s = await send({ type: 'status' });
  $('signin').classList.toggle('hidden', !!(s && s.signedIn));
  $('app').classList.toggle('hidden', !(s && s.signedIn));
  if (s && s.signedIn) { $('whoEmail').textContent = s.email; $('name').value = s.name || ''; }
}

$('send').addEventListener('click', async () => {
  const email = $('email').value.trim().toLowerCase();
  if (!email) return ($('err1').textContent = 'Enter your email.');
  $('send').disabled = true; $('err1').textContent = '';
  const r = await send({ type: 'sendCode', email });
  $('send').disabled = false;
  if (!r.ok) return ($('err1').textContent = r.error);
  $('codeWrap').classList.remove('hidden'); $('code').focus();
});
$('verify').addEventListener('click', async () => {
  const email = $('email').value.trim().toLowerCase(); const code = $('code').value.trim();
  $('verify').disabled = true; $('err1').textContent = '';
  const r = await send({ type: 'verify', email, code });
  $('verify').disabled = false;
  if (!r.ok) return ($('err1').textContent = r.error);
  render();
});
$('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('verify').click(); });
$('email').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('send').click(); });
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
