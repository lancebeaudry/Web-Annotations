import { h, fmtDate } from '../ui/dom.js';
import { pageHead } from '../ui/shell.js';
import { listProjects, account, openCounts } from '../api.js';

const PLAN = { free: 'Free plan', pro: 'Pro', agency: 'Agency' };

export async function projectsScreen({ user }) {
  const [projects, acct, counts] = await Promise.all([listProjects(), account(), openCounts().catch(() => ({}))]);
  const mine = projects.filter((p) => p.owner_id === user.id);
  const shared = projects.filter((p) => p.owner_id !== user.id);
  const unlimited = acct.project_limit >= 2147483647;
  const canCreate = unlimited || acct.owned_count < acct.project_limit;

  const planLine = h(
    'div',
    { class: 'plan-line' },
    h('span', { class: `badge ${acct.plan === 'pro' ? 'badge-pro' : acct.plan === 'agency' ? 'badge-agency' : ''}` }, acct.is_operator ? 'Operator' : PLAN[acct.plan] || 'Free plan'),
    unlimited ? 'Unlimited projects' : `${acct.owned_count} of ${acct.project_limit} project${acct.project_limit === 1 ? '' : 's'} used`,
    !unlimited && acct.owned_count >= acct.project_limit ? h('a', { href: '#/account' }, 'Upgrade for more') : null
  );

  const tile = (p) => {
    const open = counts[p.id] || 0;
    return h(
      'a',
      { class: 'pcard', href: `#/projects/${p.id}` },
      h('div', { class: 'name' }, p.name),
      h('div', { class: 'url' }, p.site_url.replace(/^https?:\/\//, '')),
      h('div', { class: 'meta' },
        h('span', { class: 'open' }, open ? `${open} open` : 'Nothing open'),
        p.open_access ? h('span', { class: 'badge badge-ok' }, 'open feedback') : null,
        h('span', {}, `since ${fmtDate(p.created_at)}`))
    );
  };

  const create = h('a', { class: `btn ${canCreate ? '' : 'btn-disabled'}`, href: canCreate ? '#/projects/new' : '#/account' }, canCreate ? 'New project' : 'Upgrade to add projects');

  const sections = [
    pageHead('Projects', planLine, create),
    mine.length ? h('div', { class: 'grid' }, ...mine.map(tile)) : h('div', { class: 'empty' }, 'No projects yet. Create one to get your share link and install instructions.'),
  ];
  if (shared.length) {
    sections.push(h('h3', { style: 'margin:28px 0 12px;font-size:18px' }, acct.is_operator ? 'All customer projects' : 'Shared with you'), h('div', { class: 'grid' }, ...shared.map(tile)));
  }
  return h('div', {}, ...sections);
}
