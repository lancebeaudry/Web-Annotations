// Feedback inbox for one project: every comment across the site, with
// status, assignee, labels and effort editable inline, a list and a board
// view, a "Needs your decision" view for the client, and deep links that
// open the item on the live site.
import { h, fmtDate, toast } from '../ui/dom.js';
import { card, pageHead } from '../ui/shell.js';
import { getProject, listComments, patchComment, assignees as listAssignees, projectAccess, sendDigest, setDigestWeekly } from '../api.js';

const STATUS = { open: 'Open', in_progress: 'In progress', waiting: 'Waiting on client', resolved: 'Resolved', wont_fix: "Won't fix" };
const ORDER = ['open', 'in_progress', 'waiting', 'resolved', 'wont_fix'];
const isOpen = (s) => s === 'open' || s === 'in_progress' || s === 'waiting';
const LABEL = { bug: 'Bug', copy: 'Copy', design: 'Design', content: 'Content needed', photo: 'Photo needed', decision: 'Decision' };
const LABELS = Object.keys(LABEL);
const EFFORT = { quick: 'Quick', medium: 'Medium', large: 'Large' };
const deviceOf = (w) => (!Number(w) ? null : Number(w) < 600 ? 'mobile' : Number(w) < 1024 ? 'tablet' : 'desktop');
const DEVICE = { mobile: 'Mobile', tablet: 'Tablet', desktop: 'Desktop' };

export async function feedbackScreen({ id, user, acct, query }) {
  const p = await getProject(id);
  if (!p) return card('Not found', h('p', {}, 'This project doesn’t exist or you don’t have access.'), h('a', { class: 'btn', href: '#/projects' }, 'Back'));
  const canManage = acct.is_operator || p.owner_id === user.id;
  const me = (user.email || '').toLowerCase();
  const [rows, people, access] = await Promise.all([listComments(id), canManage ? listAssignees(id).catch(() => []) : Promise.resolve([]), projectAccess(id).catch(() => ({}))]);
  const roots = rows.filter((r) => !r.parent_id);
  const repliesOf = (rid) => rows.filter((r) => r.parent_id === rid);
  const link = (c) => `${c.page_url}?markup=${encodeURIComponent(p.token)}&pp_comment=${c.id}`;

  const f = { status: query.status || 'open', page: '', assignee: '', label: query.label || '', device: '', kind: query.kind || '', q: '', view: query.view || 'list' };
  const pages = [...new Set(roots.map((r) => r.page_path))].sort();

  const statusSel = h('select', {}, h('option', { value: 'open' }, 'All open'), ...ORDER.map((s) => h('option', { value: s }, STATUS[s])), h('option', { value: 'all' }, 'Everything'));
  statusSel.value = f.status;
  const pageSel = h('select', {}, h('option', { value: '' }, 'All pages'), ...pages.map((pg) => h('option', { value: pg }, pg)));
  const assigneeSel = h('select', {}, h('option', { value: '' }, 'Anyone'), h('option', { value: '__none' }, 'Unassigned'), ...people.map((e) => h('option', { value: e }, e)));
  const labelSel = h('select', {}, h('option', { value: '' }, 'Any label'), ...LABELS.map((l) => h('option', { value: l }, LABEL[l])), h('option', { value: '__none' }, 'Untriaged'));
  labelSel.value = f.label;
  const kindSel = h('select', {}, h('option', { value: '' }, 'Comments and references'), h('option', { value: 'comment' }, 'Comments only'), h('option', { value: 'reference' }, 'References only'));
  const deviceSel = h('select', {}, h('option', { value: '' }, 'All devices'), h('option', { value: 'desktop' }, 'Desktop'), h('option', { value: 'tablet' }, 'Tablet'), h('option', { value: 'mobile' }, 'Mobile'));
  const search = h('input', { type: 'search', placeholder: 'Search feedback…' });
  const viewSeg = h('div', { class: 'seg' });
  const body = h('div', {});

  const canEdit = (c) => canManage || (c.assignee_email && c.assignee_email.toLowerCase() === me);
  const T = access.triage || {};
  const on = (k) => T[k] !== false;

  function matches(c, ignoreStatus = false) {
    if (!ignoreStatus && (f.status === 'open' ? !isOpen(c.status) : f.status !== 'all' && c.status !== f.status)) return false;
    if (f.page && c.page_path !== f.page) return false;
    if (f.assignee === '__none' ? c.assignee_email : f.assignee && c.assignee_email !== f.assignee) return false;
    const labels = c.labels || [];
    if (f.label === '__none' ? labels.length : f.label && !labels.includes(f.label)) return false;
    if (f.device && (deviceOf(c.viewport_w) || 'desktop') !== f.device) return false;
    if (f.kind && (c.kind || 'comment') !== f.kind) return false;
    const needle = f.q.trim().toLowerCase();
    if (needle && !`${c.comment_text} ${c.author_name || ''} ${c.current_text || ''} ${c.page_path}`.toLowerCase().includes(needle)) return false;
    return true;
  }
  const visible = () => roots.filter((c) => matches(c)).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  async function setField(c, patch, el) {
    el.disabled = true;
    try {
      const r = await patchComment(c.id, patch);
      Object.assign(c, r);
      render();
    } catch (err) {
      toast(err.message);
      el.disabled = false;
    }
  }

  const statusCtl = (c) => {
    const s = h('select', { class: `mini st-${c.status}` }, ...ORDER.map((k) => h('option', { value: k }, STATUS[k])));
    s.value = c.status;
    s.addEventListener('change', () => setField(c, { status: s.value }, s));
    return s;
  };
  const assigneeCtl = (c) => {
    const s = h('select', { class: 'mini' }, h('option', { value: '' }, 'Unassigned'), ...people.map((e) => h('option', { value: e }, e)));
    if (c.assignee_email && !people.includes(c.assignee_email)) s.appendChild(h('option', { value: c.assignee_email }, c.assignee_email));
    s.value = c.assignee_email || '';
    s.addEventListener('change', () => setField(c, { assignee_email: s.value || null }, s));
    return s;
  };
  const effortCtl = (c) => {
    const s = h('select', { class: 'mini', title: 'Effort' }, h('option', { value: '' }, 'Effort'), ...Object.keys(EFFORT).map((k) => h('option', { value: k }, EFFORT[k])));
    s.value = c.effort || '';
    s.addEventListener('change', () => setField(c, { effort: s.value || null }, s));
    return s;
  };
  // Labels: clickable chips for editors, plain chips for everyone else.
  const labelChips = (c, editable) => {
    const have = new Set(c.labels || []);
    const wrap = h('span', { class: 'chips' });
    for (const l of editable ? LABELS : [...have]) {
      const chip = h(editable ? 'button' : 'span', { type: editable ? 'button' : null, class: `chip lb-${l}${have.has(l) ? ' on' : ''}` }, LABEL[l]);
      if (editable) chip.addEventListener('click', () => {
        if (have.has(l)) have.delete(l); else have.add(l);
        setField(c, { labels: LABELS.filter((x) => have.has(x)) }, chip);
      });
      wrap.appendChild(chip);
    }
    return wrap;
  };

  function item(c) {
    const n = repliesOf(c.id).length;
    const ctx = c.context || {};
    const isRef = c.kind === 'reference';
    const sub = [
      isRef ? (c.page_path ? `${c.page_path} (reference)` : 'Reference, not yet attached') : c.page_path,
      `<${c.element_tag || 'page'}>`,
      deviceOf(c.viewport_w) && deviceOf(c.viewport_w) !== 'desktop' ? `${DEVICE[deviceOf(c.viewport_w)]} (${c.viewport_w}px)` : '',
      `${c.author_name || c.author_email} · ${fmtDate(c.created_at)}`,
      n ? `${n} repl${n === 1 ? 'y' : 'ies'}` : '',
      ctx.browser ? `${ctx.browser}${ctx.os ? ' on ' + ctx.os : ''}` : '',
      (ctx.errors || []).length ? `${ctx.errors.length} console error${ctx.errors.length === 1 ? '' : 's'}` : '',
      c.external_ref?.clickup_url ? 'in ClickUp' : '',
    ].filter(Boolean).join(' · ');
    const editable = canEdit(c);
    const ctl = h('div', { class: 'ctl' },
      !on('status') ? null : editable ? statusCtl(c) : h('span', { class: `st ${c.status}` }, STATUS[c.status] || c.status),
      !on('effort') ? null : editable ? effortCtl(c) : c.effort ? h('span', { class: 'st' }, EFFORT[c.effort]) : null,
      !on('assignee') ? null : canManage ? assigneeCtl(c) : c.assignee_email ? h('span', { class: 'hint' }, `→ ${c.assignee_email}`) : null,
      h('a', { class: 'btn btn-ghost btn-sm', href: link(c), target: '_blank', rel: 'noopener' }, 'Open on site'),
      c.external_ref?.clickup_url ? h('a', { class: 'btn btn-ghost btn-sm', href: c.external_ref.clickup_url, target: '_blank', rel: 'noopener' }, 'ClickUp') : null);
    const main = h('div', {}, h('div', { class: 'txt' }, c.comment_text), h('div', { class: 'sub' }, sub));
    if (isRef && c.source) main.appendChild(h('div', { class: 'refbox' }, c.source.screenshot ? h('img', { src: c.source.screenshot, alt: '' }) : null, h('a', { href: c.source.url, target: '_blank', rel: 'noopener' }, `From ${c.source.host || 'another site'}`)));
    if (on('labels') && (editable || (c.labels || []).length)) main.appendChild(labelChips(c, editable));
    return h('div', { class: `fb ${isOpen(c.status) ? '' : 'closed'}${c.status === 'waiting' ? ' waiting' : ''}` }, main, ctl);
  }

  function board(list) {
    return h('div', { class: 'board' }, ...ORDER.map((s) =>
      h('div', { class: 'col' }, h('h5', {}, `${STATUS[s]} (${list.filter((c) => c.status === s).length})`),
        ...list.filter((c) => c.status === s).map((c) => {
          const el = h('div', { class: 'cardlet', title: 'Open on site' }, c.comment_text.slice(0, 120),
            (c.labels || []).length || c.effort ? h('div', { class: 'chips' }, ...(c.labels || []).map((l) => h('span', { class: `chip on lb-${l}` }, LABEL[l])), c.effort ? h('span', { class: 'chip' }, EFFORT[c.effort]) : null) : null,
            h('div', { class: 'sub' }, `${c.page_path} · ${c.assignee_email ? '→ ' + c.assignee_email.split('@')[0] : c.author_name || 'reviewer'}`));
          el.addEventListener('click', () => window.open(link(c), '_blank', 'noopener'));
          return el;
        }))));
  }

  // Counts for the summary strip: what we own vs what the client decides.
  const summary = h('div', { class: 'triage-strip' });
  function renderSummary() {
    const open = roots.filter((c) => isOpen(c.status));
    const waiting = open.filter((c) => c.status === 'waiting');
    const ours = open.filter((c) => c.status !== 'waiting');
    const quick = ours.filter((c) => c.effort === 'quick').length;
    const medium = ours.filter((c) => c.effort === 'medium').length;
    const large = ours.filter((c) => c.effort === 'large').length;
    const untriaged = open.filter((c) => !(c.labels || []).length && !c.effort && c.status !== 'waiting').length;
    const pill = (label, n, on) => {
      const b = h('button', { type: 'button', class: `tpill${n ? '' : ' empty'}` }, h('b', {}, String(n)), ' ', label);
      b.addEventListener('click', on);
      return b;
    };
    summary.replaceChildren(...[
      on('status') ? pill('waiting on the client', waiting.length, () => { f.status = 'waiting'; statusSel.value = 'waiting'; f.label = ''; labelSel.value = ''; render(); }) : null,
      on('effort') ? pill('quick wins', quick, () => { f.status = 'open'; statusSel.value = 'open'; f.q = ''; search.value = ''; render('quick'); }) : null,
      on('effort') ? pill('medium', medium, () => render('medium')) : null,
      on('effort') ? pill('large', large, () => render('large')) : null,
      on('effort') || on('labels') ? pill('untriaged', untriaged, () => { f.status = 'open'; statusSel.value = 'open'; f.label = '__none'; labelSel.value = '__none'; render(); }) : null,
    ].filter(Boolean));
    summary.style.display = summary.children.length ? '' : 'none';
  }

  function render(effortOnly) {
    viewSeg.replaceChildren(...['list', 'board'].map((v) => {
      const b = h('button', { type: 'button', class: v === f.view ? 'on' : '' }, v === 'list' ? 'List' : 'Board');
      b.addEventListener('click', () => { f.view = v; render(); });
      return b;
    }));
    let list = f.view === 'board' ? roots.filter((c) => matches(c, true)) : visible();
    if (effortOnly) list = list.filter((c) => c.effort === effortOnly && c.status !== 'waiting');
    body.replaceChildren(list.length || f.view === 'board' ? (f.view === 'board' ? board(list) : h('div', {}, ...list.map(item))) : h('p', { class: 'hint' }, roots.length ? 'Nothing matches these filters.' : 'No feedback yet. Share the review link and comments will show up here.'));
    renderSummary();
  }
  statusSel.addEventListener('change', () => { f.status = statusSel.value; render(); });
  pageSel.addEventListener('change', () => { f.page = pageSel.value; render(); });
  assigneeSel.addEventListener('change', () => { f.assignee = assigneeSel.value; render(); });
  labelSel.addEventListener('change', () => { f.label = labelSel.value; render(); });
  deviceSel.addEventListener('change', () => { f.device = deviceSel.value; render(); });
  kindSel.value = f.kind; kindSel.addEventListener('change', () => { f.kind = kindSel.value; render(); });
  search.addEventListener('input', () => { f.q = search.value; render(); });
  render();

  // Digest: email the client what is waiting on them, now or weekly.
  let digestCard = null;
  if (canManage) {
    const sendBtn = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, 'Email the client now');
    sendBtn.addEventListener('click', async () => {
      const n = roots.filter((c) => c.status === 'waiting').length;
      if (!n) return toast('Nothing is waiting on the client');
      sendBtn.disabled = true;
      try {
        const r = await sendDigest(id);
        toast(r.sent ? `Sent to ${r.to.join(', ')}` : 'No collaborators to send to — invite them first');
      } catch (err) { toast(err.message); }
      sendBtn.disabled = false;
    });
    const weekly = h('input', { type: 'checkbox' });
    weekly.checked = access.digest_weekly === true;
    weekly.addEventListener('change', async () => {
      try { await setDigestWeekly(id, weekly.checked); toast(weekly.checked ? 'Weekly digest on' : 'Weekly digest off'); }
      catch (err) { weekly.checked = !weekly.checked; toast(err.message); }
    });
    digestCard = h('div', { class: 'digest' },
      h('div', {}, h('b', {}, 'Needs your decision'), h('div', { class: 'hint' }, 'Emails every collaborator the items marked “Waiting on client”, grouped by page, with a link to reply on the site.')),
      h('div', { class: 'inline' }, sendBtn, h('label', { class: 'check', style: 'margin:0' }, weekly, h('span', {}, 'Send every Monday'))));
  }

  const openCount = roots.filter((c) => isOpen(c.status)).length;
  return h(
    'div',
    {},
    pageHead(p.name, p.site_url, h('a', { class: 'btn btn-ghost', href: '#/projects' }, 'All projects'), h('a', { class: 'btn', href: `${p.site_url.replace(/\/$/, '')}/?markup=${p.token}`, target: '_blank', rel: 'noopener' }, 'Open site in PinPoint')),
    h('div', { class: 'tabs' }, h('a', { href: `#/projects/${id}` }, 'Settings'), h('a', { class: 'on', href: `#/projects/${id}/feedback` }, `Feedback (${openCount} open)`)),
    card(null, summary, h('div', { class: 'filters' }, on('status') ? statusSel : null, pageSel, on('labels') ? labelSel : null, kindSel, deviceSel, canManage && on('assignee') ? assigneeSel : null, search, viewSeg), body, on('status') ? digestCard : null)
  );
}
