// Feedback inbox for one project: every comment across the site, with
// status and assignee editable inline, a list and a board view, and deep
// links that open the item on the live site.
import { h, fmtDate, toast } from '../ui/dom.js';
import { card } from '../ui/shell.js';
import { getProject, listComments, patchComment, assignees as listAssignees } from '../api.js';

const STATUS = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved', wont_fix: "Won't fix" };
const ORDER = ['open', 'in_progress', 'resolved', 'wont_fix'];
const isOpen = (s) => s === 'open' || s === 'in_progress';

export async function feedbackScreen({ id, user, acct, query }) {
  const p = await getProject(id);
  if (!p) return card('Not found', h('p', {}, 'This project doesn’t exist or you don’t have access.'), h('a', { class: 'btn', href: '#/projects' }, 'Back'));
  const canManage = acct.is_operator || p.owner_id === user.id;
  const me = (user.email || '').toLowerCase();
  const [rows, people] = await Promise.all([listComments(id), canManage ? listAssignees(id).catch(() => []) : Promise.resolve([])]);
  const roots = rows.filter((r) => !r.parent_id);
  const repliesOf = (rid) => rows.filter((r) => r.parent_id === rid);
  const link = (c) => `${c.page_url}?markup=${encodeURIComponent(p.token)}&pp_comment=${c.id}`;

  const f = { status: query.status || 'open', page: '', assignee: '', q: '', view: query.view || 'list' };
  const pages = [...new Set(roots.map((r) => r.page_path))].sort();

  const statusSel = h('select', {}, h('option', { value: 'open' }, 'Open + in progress'), ...ORDER.map((s) => h('option', { value: s }, STATUS[s])), h('option', { value: 'all' }, 'All'));
  statusSel.value = f.status;
  const pageSel = h('select', {}, h('option', { value: '' }, 'All pages'), ...pages.map((pg) => h('option', { value: pg }, pg)));
  const assigneeSel = h('select', {}, h('option', { value: '' }, 'Anyone'), h('option', { value: '__none' }, 'Unassigned'), ...people.map((e) => h('option', { value: e }, e)));
  const search = h('input', { type: 'search', placeholder: 'Search feedback…' });
  const viewSeg = h('div', { class: 'seg' });
  const body = h('div', {});

  const canEdit = (c) => canManage || (c.assignee_email && c.assignee_email.toLowerCase() === me);

  function visible() {
    const needle = f.q.trim().toLowerCase();
    return roots.filter((c) => {
      if (f.status === 'open' ? !isOpen(c.status) : f.status !== 'all' && c.status !== f.status) return false;
      if (f.page && c.page_path !== f.page) return false;
      if (f.assignee === '__none' ? c.assignee_email : f.assignee && c.assignee_email !== f.assignee) return false;
      if (needle && !`${c.comment_text} ${c.author_name || ''} ${c.current_text || ''} ${c.page_path}`.toLowerCase().includes(needle)) return false;
      return true;
    }).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }

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
    const s = h('select', { class: 'mini' }, ...ORDER.map((k) => h('option', { value: k }, STATUS[k])));
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

  function item(c) {
    const n = repliesOf(c.id).length;
    const ctx = c.context || {};
    const sub = [
      c.page_path,
      `<${c.element_tag || 'page'}>`,
      `${c.author_name || c.author_email} · ${fmtDate(c.created_at)}`,
      n ? `${n} repl${n === 1 ? 'y' : 'ies'}` : '',
      ctx.browser ? `${ctx.browser}${ctx.os ? ' on ' + ctx.os : ''}` : '',
      (ctx.errors || []).length ? `${ctx.errors.length} console error${ctx.errors.length === 1 ? '' : 's'}` : '',
      c.external_ref?.clickup_url ? 'in ClickUp' : '',
    ].filter(Boolean).join(' · ');
    const ctl = h('div', { class: 'ctl' },
      h('span', { class: `st ${c.status}` }, STATUS[c.status] || c.status),
      canEdit(c) ? statusCtl(c) : null,
      canManage ? assigneeCtl(c) : c.assignee_email ? h('span', { class: 'hint' }, `→ ${c.assignee_email}`) : null,
      h('a', { class: 'btn btn-ghost btn-sm', href: link(c), target: '_blank', rel: 'noopener' }, 'Open on site'),
      c.external_ref?.clickup_url ? h('a', { class: 'btn btn-ghost btn-sm', href: c.external_ref.clickup_url, target: '_blank', rel: 'noopener' }, 'ClickUp') : null);
    return h('div', { class: `fb ${isOpen(c.status) ? '' : 'closed'}` }, h('div', {}, h('div', { class: 'txt' }, c.comment_text), h('div', { class: 'sub' }, sub)), ctl);
  }

  function board(list) {
    return h('div', { class: 'board' }, ...ORDER.map((s) =>
      h('div', { class: 'col' }, h('h5', {}, `${STATUS[s]} (${list.filter((c) => c.status === s).length})`),
        ...list.filter((c) => c.status === s).map((c) => {
          const el = h('div', { class: 'cardlet', title: 'Open on site' }, c.comment_text.slice(0, 120), h('div', { class: 'sub' }, `${c.page_path} · ${c.assignee_email ? '→ ' + c.assignee_email.split('@')[0] : c.author_name || 'reviewer'}`));
          el.addEventListener('click', () => window.open(link(c), '_blank', 'noopener'));
          return el;
        }))));
  }

  function render() {
    viewSeg.replaceChildren(...['list', 'board'].map((v) => {
      const b = h('button', { type: 'button', class: v === f.view ? 'on' : '' }, v === 'list' ? 'List' : 'Board');
      b.addEventListener('click', () => { f.view = v; render(); });
      return b;
    }));
    const list = f.view === 'board' ? roots.filter((c) => (!f.page || c.page_path === f.page) && (f.assignee === '__none' ? !c.assignee_email : !f.assignee || c.assignee_email === f.assignee)) : visible();
    body.replaceChildren(list.length || f.view === 'board' ? (f.view === 'board' ? board(list) : h('div', {}, ...list.map(item))) : h('p', { class: 'hint' }, roots.length ? 'Nothing matches these filters.' : 'No feedback yet. Share the review link and comments will show up here.'));
  }
  statusSel.addEventListener('change', () => { f.status = statusSel.value; render(); });
  pageSel.addEventListener('change', () => { f.page = pageSel.value; render(); });
  assigneeSel.addEventListener('change', () => { f.assignee = assigneeSel.value; render(); });
  search.addEventListener('input', () => { f.q = search.value; render(); });
  render();

  const openCount = roots.filter((c) => isOpen(c.status)).length;
  document.querySelector('main')?.classList.add('wide');
  return h(
    'div',
    {},
    h('div', { class: 'tabs' }, h('a', { href: `#/projects/${id}` }, 'Settings'), h('a', { class: 'on', href: `#/projects/${id}/feedback` }, `Feedback (${openCount} open)`)),
    card(h('div', { class: 'head-row' }, h('span', {}, `${p.name} — feedback`), h('a', { class: 'btn btn-ghost btn-sm', href: `${p.site_url.replace(/\/$/, '')}/?markup=${p.token}`, target: '_blank', rel: 'noopener' }, 'Open site')),
      h('div', { class: 'filters' }, statusSel, pageSel, canManage ? assigneeSel : null, search, viewSeg),
      body)
  );
}
