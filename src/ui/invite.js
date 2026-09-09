import { h, toast } from './overlay.js';
import { inviteEmail, listInvites, revokeInvite, getBridgeSecret, rotateBridgeSecret } from '../data.js';
import { DASHBOARD_URL } from '../config.js';

// Owner/operator "Invite" panel: add a collaborator's email to the project,
// see who's already invited, remove people, and reveal or rotate the site's
// bridge secret (what the WordPress plugin uses to prove it speaks for this
// site). Backed by owner-gated DB functions — no secrets on the client.

export function toggleInviteMenu(app) {
  const existing = app.ui.layer.querySelector('.invite-menu');
  if (existing) {
    existing.remove();
    return;
  }

  const emailInput = h('input', { type: 'email', placeholder: 'reviewer@example.com' });
  const noteInput = h('input', { type: 'text', placeholder: 'Note (optional) — e.g. marketing lead' });
  const sendBtn = h('button', { class: 'btn', type: 'submit' }, 'Send invite');
  const list = h('div', { class: 'invite-list' });

  const form = h(
    'form',
    {},
    h('div', { class: 'field' }, h('label', {}, 'Invite a collaborator'), emailInput),
    h('div', { class: 'field' }, noteInput),
    h('div', { class: 'btn-row' }, sendBtn)
  );

  // Site secret (WordPress plugin bridge). Revealed on demand, never
  // rendered until asked for.
  const secretOut = h('code', { class: 'secret-value' }, '••••••••••••');
  const revealBtn = h('button', { class: 'mini-btn', type: 'button' }, 'Reveal');
  const copyBtn = h('button', { class: 'mini-btn', type: 'button' }, 'Copy');
  const rotateBtn = h('button', { class: 'mini-btn danger', type: 'button' }, 'Rotate');
  let secret = '';
  const showSecret = (v) => {
    secret = v;
    secretOut.textContent = v;
  };
  revealBtn.addEventListener('click', async () => {
    revealBtn.disabled = true;
    const r = await getBridgeSecret(app.supabase, app.project.id);
    revealBtn.disabled = false;
    if (r.error) return toast(app.ui, r.error);
    showSecret(r.secret);
  });
  copyBtn.addEventListener('click', async () => {
    if (!secret) return toast(app.ui, 'Reveal the secret first');
    try {
      await navigator.clipboard.writeText(secret);
      toast(app.ui, 'Site secret copied');
    } catch {
      toast(app.ui, 'Copy failed — select and copy it manually');
    }
  });
  rotateBtn.addEventListener('click', async () => {
    if (!confirm('Rotate the site secret? The WordPress plugin on this site will stop syncing until wp-config.php is updated with the new value.')) return;
    rotateBtn.disabled = true;
    const r = await rotateBridgeSecret(app.supabase, app.project.id);
    rotateBtn.disabled = false;
    if (r.error) return toast(app.ui, r.error);
    showSecret(r.secret);
    toast(app.ui, 'Site secret rotated — update wp-config.php');
  });
  const secretBox = h(
    'div',
    { class: 'secret-box' },
    h('div', { class: 'invite-sub' }, 'Site secret (WordPress plugin)'),
    h('p', { class: 'hint' }, 'Put this in wp-config.php as ', h('code', {}, 'AVALANCHE_MARKUP_PROJECT_SECRET'), ' so the plugin can sync settings and sign editors in.'),
    h('div', { class: 'secret-row' }, secretOut, revealBtn, copyBtn, rotateBtn)
  );

  const menu = h(
    'div',
    { class: 'card invite-menu' },
    h(
      'div',
      { class: 'card-head' },
      h('span', {}, `Access · ${app.project.name}`),
      h('button', { class: 'close', onclick: () => menu.remove() }, '✕')
    ),
    h(
      'div',
      { class: 'card-body' },
      form,
      h('div', { class: 'invite-sub' }, 'Collaborators'),
      list,
      secretBox,
      h(
        'p',
        { class: 'hint invite-foot' },
        h('a', { href: `${DASHBOARD_URL}#/projects/${app.project.id}`, target: '_blank', rel: 'noopener' }, 'Manage collaborators, notifications and settings in the dashboard')
      )
    )
  );

  async function refreshList() {
    list.replaceChildren(h('div', { class: 'invite-empty' }, 'Loading…'));
    const rows = await listInvites(app.supabase, app.project.id);
    if (!rows.length) {
      list.replaceChildren(h('div', { class: 'invite-empty' }, 'No one invited yet. You (the owner) always have access.'));
      return;
    }
    list.replaceChildren(
      ...rows.map((r) => {
        const remove = h('button', { class: 'mini-btn danger' }, 'Remove');
        remove.addEventListener('click', async () => {
          remove.disabled = true;
          const err = await revokeInvite(app.supabase, app.project.id, r.email);
          if (err) {
            remove.disabled = false;
            toast(app.ui, err);
            return;
          }
          refreshList();
        });
        return h(
          'div',
          { class: 'invite-row' },
          h('div', {}, h('div', { class: 'invite-email' }, r.email), r.note ? h('div', { class: 'invite-note' }, r.note) : null),
          remove
        );
      })
    );
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = emailInput.value.trim();
    if (!email) return;
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';
    const err = await inviteEmail(app.supabase, app.project.id, email, noteInput.value.trim());
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send invite';
    if (err) {
      toast(app.ui, err);
      return;
    }
    emailInput.value = '';
    noteInput.value = '';
    toast(app.ui, `Invited ${email}`);
    refreshList();
  });

  app.ui.layer.appendChild(menu);
  refreshList();
}
