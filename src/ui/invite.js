import { h, toast } from './overlay.js';
import { inviteEmail, listInvites, revokeInvite } from '../data.js';

// Team-only "Invite" panel: add a client email to the access list,
// see who's already invited, and remove people. Backed by the
// team-gated DB functions — no secrets on the client.

export function toggleInviteMenu(app) {
  const existing = app.ui.layer.querySelector('.invite-menu');
  if (existing) {
    existing.remove();
    return;
  }

  const emailInput = h('input', { type: 'email', placeholder: 'client@example.com' });
  const noteInput = h('input', { type: 'text', placeholder: 'Note (optional) — e.g. Gordon Water' });
  const sendBtn = h('button', { class: 'btn', type: 'submit' }, 'Send invite');
  const list = h('div', { class: 'invite-list' });

  const form = h(
    'form',
    {},
    h('div', { class: 'field' }, h('label', {}, 'Invite a client'), emailInput),
    h('div', { class: 'field' }, noteInput),
    h('div', { class: 'btn-row' }, sendBtn)
  );

  const menu = h(
    'div',
    { class: 'card invite-menu' },
    h(
      'div',
      { class: 'card-head' },
      h('span', {}, 'Client access'),
      h('button', { class: 'close', onclick: () => menu.remove() }, '✕')
    ),
    h('div', { class: 'card-body' }, form, h('div', { class: 'invite-sub' }, 'Invited clients'), list)
  );

  async function refreshList() {
    list.replaceChildren(h('div', { class: 'invite-empty' }, 'Loading…'));
    const rows = await listInvites(app.supabase);
    if (!rows.length) {
      list.replaceChildren(h('div', { class: 'invite-empty' }, 'No clients invited yet. Team members (@avalanchegr.com) always have access.'));
      return;
    }
    list.replaceChildren(
      ...rows.map((r) => {
        const remove = h('button', { class: 'mini-btn danger' }, 'Remove');
        remove.addEventListener('click', async () => {
          remove.disabled = true;
          const err = await revokeInvite(app.supabase, r.email);
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
    const err = await inviteEmail(app.supabase, email, noteInput.value.trim());
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
