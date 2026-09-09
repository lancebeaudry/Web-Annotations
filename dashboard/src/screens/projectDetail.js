import { h, field, toast, copyBox } from '../ui/dom.js';
import { card } from '../ui/shell.js';
import { getProject, updateSettings, listInvites, invite, revoke, listNotify, setNotify, bridgeSecret, rotateSecret, deleteProject } from '../api.js';
import { BUNDLE_URL, PLUGIN_ZIP_URL } from '../config.js';
import { go } from '../router.js';

export async function projectDetailScreen({ id, user, acct }) {
  const p = await getProject(id);
  if (!p) return card('Not found', h('p', {}, 'This project doesn’t exist or you don’t have access.'), h('a', { class: 'btn', href: '#/projects' }, 'Back'));
  const canManage = acct.is_operator || p.owner_id === user.id;
  const shareLink = `${p.site_url.replace(/\/$/, '')}/?markup=${p.token}`;

  // --- Share + install
  const install = card(
    'Share & install',
    h('p', {}, 'Send this link to anyone who should review the site:'),
    copyBox(shareLink),
    h('h4', {}, 'WordPress'),
    h(
      'ol',
      { class: 'steps' },
      h('li', {}, 'Install the plugin: ', h('a', { href: PLUGIN_ZIP_URL }, 'download avalanche-markup.zip'), ' → Plugins → Add New → Upload.'),
      h('li', {}, 'Settings → Avalanche Markup → paste the token ', h('code', {}, p.token), ' and save.'),
      h('li', {}, 'Add the site secret (below) to ', h('code', {}, 'wp-config.php'), ' so the plugin can sync settings and sign your editors in.')
    ),
    h('h4', {}, 'Any other site'),
    h('p', { class: 'hint' }, 'Paste this in the <head>:'),
    copyBox(`<script defer src="${BUNDLE_URL}" data-project="${p.token}"${p.open_access ? ' data-open="1"' : ''}></script>`, { multiline: true })
  );

  if (!canManage) return h('div', {}, card(p.name, h('p', { class: 'hint' }, p.site_url)), install);

  // --- Settings
  const name = h('input', { type: 'text', value: p.name });
  const site = h('input', { type: 'url', value: p.site_url });
  const open = h('input', { type: 'checkbox' });
  open.checked = !!p.open_access;
  const save = h('button', { class: 'btn', type: 'submit' }, 'Save settings');
  const settingsForm = h(
    'form',
    {},
    field('Project name', name),
    field('Site URL', site),
    h('label', { class: 'check' }, open, ' Open feedback — anyone with the link can comment after entering their name (staging sites only; the token is visible in page source)'),
    h('div', { class: 'btn-row' }, save)
  );
  settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    save.disabled = true;
    try {
      await updateSettings(id, { name: name.value.trim(), site_url: new URL(site.value.trim()).origin, open_access: open.checked });
      toast('Saved');
      go(`#/projects/${id}`);
      location.reload();
    } catch (err) {
      toast(err.message);
    }
    save.disabled = false;
  });

  // --- Collaborators
  const inviteEmail = h('input', { type: 'email', placeholder: 'reviewer@example.com' });
  const inviteNote = h('input', { type: 'text', placeholder: 'Note (optional)' });
  const inviteBtn = h('button', { class: 'btn', type: 'submit' }, 'Invite');
  const inviteList = h('div', { class: 'rows' });
  async function refreshInvites() {
    const rows = await listInvites(id).catch(() => []);
    inviteList.replaceChildren(
      ...(rows.length
        ? rows.map((r) => {
            const rm = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, 'Remove');
            rm.addEventListener('click', async () => {
              rm.disabled = true;
              await revoke(id, r.email).catch((e) => toast(e.message));
              refreshInvites();
            });
            return h('div', { class: 'row' }, h('div', {}, h('div', { class: 'row-title' }, r.email), r.note ? h('div', { class: 'hint' }, r.note) : null), rm);
          })
        : [h('p', { class: 'hint' }, 'No collaborators yet. You always have access as the owner.')])
    );
  }
  const inviteForm = h('form', {}, h('div', { class: 'inline' }, inviteEmail, inviteNote, inviteBtn));
  inviteForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!inviteEmail.value.trim()) return;
    inviteBtn.disabled = true;
    try {
      await invite(id, inviteEmail.value.trim(), inviteNote.value.trim());
      inviteEmail.value = '';
      inviteNote.value = '';
      toast('Invited');
      refreshInvites();
    } catch (err) {
      toast(err.message);
    }
    inviteBtn.disabled = false;
  });
  refreshInvites();

  // --- Notifications
  const notify = h('textarea', { rows: '4', class: 'code', placeholder: 'you@example.com\nteammate@example.com' });
  const notifySave = h('button', { class: 'btn', type: 'submit' }, 'Save recipients');
  listNotify(id).then((rows) => (notify.value = rows.join('\n'))).catch(() => {});
  const notifyForm = h('form', {}, h('p', { class: 'hint' }, 'Emailed on every new comment or reply, one address per line. @mentions always notify the person tagged.'), notify, h('div', { class: 'btn-row' }, notifySave));
  notifyForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    notifySave.disabled = true;
    try {
      const n = await setNotify(id, notify.value.split(/[\s,;]+/).filter(Boolean));
      toast(n ? `${n} recipient${n === 1 ? '' : 's'} saved` : 'Notifications off');
    } catch (err) {
      toast(err.message);
    }
    notifySave.disabled = false;
  });

  // --- Site secret
  const secretOut = h('input', { class: 'code', readonly: true, value: '••••••••••••••••••••' });
  const reveal = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, 'Reveal');
  const rotate = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, 'Rotate');
  const copy = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, 'Copy');
  let secret = '';
  reveal.addEventListener('click', async () => {
    try {
      secret = await bridgeSecret(id);
      secretOut.value = secret;
    } catch (err) {
      toast(err.message);
    }
  });
  copy.addEventListener('click', async () => {
    if (!secret) return toast('Reveal it first');
    await navigator.clipboard.writeText(`define( 'AVALANCHE_MARKUP_PROJECT_SECRET', '${secret}' );`).catch(() => {});
    toast('wp-config line copied');
  });
  rotate.addEventListener('click', async () => {
    if (!confirm('Rotate the site secret? The WordPress plugin stops syncing until wp-config.php has the new value.')) return;
    try {
      secret = await rotateSecret(id);
      secretOut.value = secret;
      toast('Rotated — update wp-config.php');
    } catch (err) {
      toast(err.message);
    }
  });
  const secretCard = card(
    'Site secret (WordPress plugin)',
    h('p', { class: 'hint' }, 'Add to wp-config.php as ', h('code', {}, "define( 'AVALANCHE_MARKUP_PROJECT_SECRET', '…' );"), '. It only works for this project and can be rotated any time.'),
    h('div', { class: 'copy-box' }, secretOut, reveal, copy, rotate)
  );

  // --- Danger zone
  const confirmName = h('input', { type: 'text', placeholder: `Type "${p.name}" to confirm` });
  const del = h('button', { class: 'btn btn-danger', type: 'button' }, 'Delete project');
  del.addEventListener('click', async () => {
    if (confirmName.value.trim() !== p.name) return toast('Type the project name exactly to confirm.');
    del.disabled = true;
    try {
      await deleteProject(id);
      toast('Project deleted');
      go('#/projects');
    } catch (err) {
      toast(err.message);
      del.disabled = false;
    }
  });

  return h(
    'div',
    {},
    card(h('div', { class: 'head-row' }, h('span', {}, p.name), h('a', { class: 'btn btn-ghost btn-sm', href: shareLink, target: '_blank', rel: 'noopener' }, 'Open in Markup')), h('p', { class: 'hint' }, p.site_url)),
    install,
    card('Settings', settingsForm),
    card('Collaborators', inviteForm, inviteList),
    card('Email notifications', notifyForm),
    secretCard,
    card('Danger zone', h('p', { class: 'hint' }, 'Deleting a project removes all of its comments and images. This cannot be undone.'), h('div', { class: 'inline' }, confirmName, del))
  );
}
