import { h, field, toast, copyBox } from '../ui/dom.js';
import { card, anchored, pageHead } from '../ui/shell.js';
import { getProject, updateSettings, listInvites, invite, revoke, listNotify, setNotify, bridgeSecret, rotateSecret, agentKey, rotateAgentKey, deleteProject, projectAccess, approvals as listApprovals, reopenPage, integrations as listIntegrations, saveIntegration, removeIntegration, callFn, listComments } from '../api.js';
import { BUNDLE_URL, PLUGIN_ZIP_URL, FUNCTIONS_URL, MCP_URL } from '../config.js';
import { go } from '../router.js';

export async function projectDetailScreen({ id, user, acct, query = {} }) {
  const p = await getProject(id);
  if (!p) return card('Not found', h('p', {}, 'This project doesn’t exist or you don’t have access.'), h('a', { class: 'btn', href: '#/projects' }, 'Back'));
  const canManage = acct.is_operator || p.owner_id === user.id;
  const shareLink = `${p.site_url.replace(/\/$/, '')}/?markup=${p.token}`;
  const access = await projectAccess(id).catch(() => ({}));
  const hasFeature = (f) => acct.is_operator || (access.features || []).includes(f);
  const openCount = (await listComments(id).catch(() => [])).filter((c) => !c.parent_id && (c.status === 'open' || c.status === 'in_progress')).length;
  const tabs = h('div', { class: 'tabs' }, h('a', { class: 'on', href: `#/projects/${id}` }, 'Settings'), h('a', { href: `#/projects/${id}/feedback` }, `Feedback (${openCount} open)`));
  const head = pageHead(p.name, p.site_url, h('a', { class: 'btn btn-ghost', href: '#/projects' }, 'All projects'), h('a', { class: 'btn', href: shareLink, target: '_blank', rel: 'noopener' }, 'Open site in PinPoint'));

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
      h('li', {}, 'Settings → PinPoint → paste the token ', h('code', {}, p.token), ' and save.'),
      h('li', {}, 'Add the site secret (below) to ', h('code', {}, 'wp-config.php'), ' so the plugin can sync settings and sign your editors in.')
    ),
    h('h4', {}, 'Any other site'),
    h('p', { class: 'hint' }, 'Paste this in the <head>:'),
    copyBox(`<script defer src="${BUNDLE_URL}" data-project="${p.token}"${p.open_access ? ' data-open="1"' : ''}></script>`, { multiline: true })
  );

  if (!canManage) return h('div', {}, head, tabs, install);

  // --- Settings
  const name = h('input', { type: 'text', value: p.name });
  const site = h('input', { type: 'url', value: p.site_url });
  const open = h('input', { type: 'checkbox' });
  open.checked = !!p.open_access;
  const shots = h('input', { type: 'checkbox' });
  shots.checked = access.auto_screenshot !== false;
  const save = h('button', { class: 'btn', type: 'submit' }, 'Save settings');
  const settingsForm = h(
    'form',
    {},
    field('Project name', name),
    field('Site URL', site),
    h('label', { class: 'check' }, open, ' Open feedback — anyone with the link can comment after entering their name (staging sites only; the token is visible in page source)'),
    h('label', { class: 'check' }, shots, ' Automatic screenshots — attach a capture of the area around each new comment (the reviewer\'s browser, console errors and screen size are recorded either way)'),
    h('div', { class: 'btn-row' }, save)
  );
  settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    save.disabled = true;
    try {
      await updateSettings(id, { name: name.value.trim(), site_url: new URL(site.value.trim()).origin, open_access: open.checked, auto_screenshot: shots.checked });
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

  // --- AI assistant access
  const keyOut = h('input', { class: 'code', readonly: true, value: '••••••••••••••••••••' });
  const keyReveal = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, 'Reveal');
  const keyCopy = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, 'Copy');
  const keyRotate = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, 'Rotate');
  let akey = '';
  keyReveal.addEventListener('click', async () => {
    try {
      akey = await agentKey(id);
      keyOut.value = akey;
    } catch (err) {
      toast(err.message);
    }
  });
  keyCopy.addEventListener('click', async () => {
    if (!akey) return toast('Reveal it first');
    await navigator.clipboard.writeText(akey).catch(() => {});
    toast('Key copied');
  });
  keyRotate.addEventListener('click', async () => {
    if (!confirm('Rotate the AI assistant key? Exports already pasted into an assistant stop working until you paste a new one.')) return;
    try {
      akey = await rotateAgentKey(id);
      keyOut.value = akey;
      toast('Rotated');
    } catch (err) {
      toast(err.message);
    }
  });
  const claudeMd = [
    '## PinPoint feedback',
    'Website feedback for this project is tracked in PinPoint. When I paste a PinPoint export, work through the items in order.',
    'When an item is done, resolve it with a one-line reply describing the change, using the curl commands and the item ID from the export.',
    'Never resolve an item you did not complete. If you cannot do one, reply with why and leave it open.',
    'Before reporting that you are finished, fetch the open list again and confirm nothing you handled is still open.',
  ].join('\n');
  const agentCard = card(
    'AI assistant access',
    h('p', { class: 'hint' }, 'Let Claude Code, Cursor or another assistant reply to and resolve comments. Markdown exports from the site already include this key, the item IDs and the exact commands, so the assistant can close items itself. Treat the key like a password: it can post replies and resolve items on this project only.'),
    h('div', { class: 'copy-box' }, keyOut, keyReveal, keyCopy, keyRotate),
    h('p', { class: 'hint' }, 'Endpoint: ', h('code', {}, `${FUNCTIONS_URL}/agent`), ' — header ', h('code', {}, 'x-pinpoint-agent-key')),
    h('h4', {}, 'Claude Code (MCP)'),
    h('p', { class: 'hint' }, 'One command registers PinPoint as a tool server: list feedback, reply, set status, assign. Reveal the key first, then copy.'),
    copyBox(`claude mcp add --transport http pinpoint "${MCP_URL}" --header "x-pinpoint-agent-key: ${'<key>'}"`, { multiline: true }),
    h('h4', {}, 'Make it stick'),
    h('p', { class: 'hint' }, 'Add this to the CLAUDE.md (or equivalent rules file) in the site\'s repo so the assistant closes the loop every time, not just when you remember to ask:'),
    copyBox(claudeMd, { multiline: true })
  );

  // --- Page approvals (Agency)
  const approvalsList = h('div', { class: 'rows' });
  async function refreshApprovals() {
    const rows = await listApprovals(id).catch(() => []);
    approvalsList.replaceChildren(...(rows.length ? rows.map((a) => {
      const btn = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, 'Reopen');
      btn.addEventListener('click', async () => { btn.disabled = true; await reopenPage(id, a.page_path).catch((e) => toast(e.message)); refreshApprovals(); });
      return h('div', { class: 'row' }, h('div', {}, h('div', { class: 'row-title' }, a.page_path), h('div', { class: 'hint' }, `Approved by ${a.approved_by_name || a.approved_by_email} (${a.approved_role}) · ${fmtDate(a.created_at)}${a.note ? ' · ' + a.note : ''}`)), btn);
    }) : [h('p', { class: 'hint' }, 'No pages approved yet. Approve a page from the toolbar on the site; commenting turns off there until it is reopened.')]));
  }
  const approvalsCard = hasFeature('approvals')
    ? (refreshApprovals(), card('Page approvals', h('p', { class: 'hint' }, 'A signed-off page stops accepting new comments and shows who approved it. Owners and invited collaborators can approve; the owner or the approver can reopen.'), approvalsList))
    : card('Page approvals', h('div', { class: 'upsell' }, 'Sign off pages with a named, timestamped approval that turns commenting off. ', h('a', { href: '#/account' }, 'Part of the Agency plan.')));

  // --- Integrations (Agency)
  const intList = h('div', { class: 'rows' });
  const slackUrl = h('input', { type: 'url', placeholder: 'https://hooks.slack.com/services/…' });
  const slackBtn = h('button', { class: 'btn', type: 'button' }, 'Test & save');
  const cuToken = h('input', { type: 'text', placeholder: 'pk_… (ClickUp personal API token)', autocomplete: 'off' });
  const cuList = h('input', { type: 'text', placeholder: 'List ID (from the list URL, e.g. 901234567)' });
  const cuBtn = h('button', { class: 'btn', type: 'button' }, 'Test & save');
  async function refreshIntegrations() {
    const rows = await listIntegrations(id).catch(() => []);
    intList.replaceChildren(...(rows.length ? rows.map((r) => {
      const rm = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, 'Remove');
      rm.addEventListener('click', async () => { rm.disabled = true; await removeIntegration(id, r.kind).catch((e) => toast(e.message)); refreshIntegrations(); });
      return h('div', { class: 'row' }, h('div', {}, h('div', { class: 'row-title' }, r.kind === 'slack' ? 'Slack' : 'ClickUp'), h('div', { class: 'hint' }, `${r.summary} · connected ${fmtDate(r.updated_at)}`)), rm);
    }) : [h('p', { class: 'hint' }, 'Nothing connected yet.')]));
  }
  slackBtn.addEventListener('click', async () => {
    slackBtn.disabled = true;
    try {
      await callFn('integration-test', { project_id: id, kind: 'slack', config: { webhook_url: slackUrl.value.trim() } });
      await saveIntegration(id, 'slack', { webhook_url: slackUrl.value.trim() });
      slackUrl.value = '';
      toast('Slack connected — check the channel for a hello');
      refreshIntegrations();
    } catch (err) { toast(err.message); }
    slackBtn.disabled = false;
  });
  cuBtn.addEventListener('click', async () => {
    cuBtn.disabled = true;
    try {
      const info = await callFn('integration-test', { project_id: id, kind: 'clickup', config: { token: cuToken.value.trim(), list_id: cuList.value.trim() } });
      await saveIntegration(id, 'clickup', { token: cuToken.value.trim(), list_id: cuList.value.trim(), list_name: info.list_name });
      cuToken.value = ''; cuList.value = '';
      toast(`ClickUp connected — tasks go to "${info.list_name}"`);
      refreshIntegrations();
    } catch (err) { toast(err.message); }
    cuBtn.disabled = false;
  });
  const integrationsCard = hasFeature('integrations')
    ? (refreshIntegrations(), card('Integrations',
        intList,
        h('h4', {}, 'Slack'),
        h('p', { class: 'hint' }, 'Create an incoming webhook in Slack (Apps → Incoming Webhooks → pick a channel) and paste its URL. Every new comment and status change posts there with a link straight to the item.'),
        h('div', { class: 'inline' }, slackUrl, slackBtn),
        h('h4', {}, 'ClickUp'),
        h('p', { class: 'hint' }, 'Each new comment becomes a task in the list you choose; replies become task comments and PinPoint status changes update the task status. Use a personal API token from ClickUp → Settings → Apps.'),
        h('div', { class: 'inline' }, cuToken, cuList, cuBtn)))
    : card('Integrations', h('div', { class: 'upsell' }, 'Post every comment to Slack and turn feedback into ClickUp tasks automatically. ', h('a', { href: '#/account' }, 'Part of the Agency plan.')));

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

  const sections = [
    ['install', 'Share & install', install],
    ['settings', 'Settings', card('Settings', settingsForm)],
    ['people', 'Collaborators', card('Collaborators', inviteForm, inviteList)],
    ['notify', 'Email notifications', card('Email notifications', notifyForm)],
    ['secret', 'Site secret', secretCard],
    ['ai', 'AI assistant', agentCard],
    ['approvals', 'Page approvals', approvalsCard],
    ['integrations', 'Integrations', integrationsCard],
    ['danger', 'Delete project', card('Danger zone', h('p', { class: 'hint' }, 'Deleting a project removes all of its comments and images. This cannot be undone.'), h('div', { class: 'inline' }, confirmName, del))],
  ];
  const nav = h('nav', { class: 'side-nav' },
    h('div', { class: 'group' }, 'This project'),
    ...sections.map(([sid, label]) => h('a', { href: `#/projects/${id}?to=${sid}`, 'data-to': sid }, label)));
  nav.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-to]');
    if (!a) return;
    e.preventDefault();
    document.getElementById(a.dataset.to)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    nav.querySelectorAll('a').forEach((x) => x.classList.toggle('on', x === a));
  });
  const content = h('div', {}, ...sections.map(([sid, , el]) => anchored(sid, el)));
  const page = h('div', {}, head, tabs, h('div', { class: 'two-col' }, nav, content));
  if (query.to) setTimeout(() => document.getElementById(query.to)?.scrollIntoView({ block: 'start' }), 50);
  return page;
}
