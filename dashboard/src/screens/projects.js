import { h, fmtDate } from '../ui/dom.js';
import { card } from '../ui/shell.js';
import { listProjects, account } from '../api.js';

export async function projectsScreen({ user }) {
  const [projects, acct] = await Promise.all([listProjects(), account()]);
  const mine = projects.filter((p) => p.owner_id === user.id);
  const shared = projects.filter((p) => p.owner_id !== user.id);
  const unlimited = acct.project_limit >= 2147483647;

  const planLine = h(
    'div',
    { class: 'plan-line' },
    h('span', { class: `badge ${acct.plan === 'pro' ? 'badge-pro' : acct.plan === 'agency' ? 'badge-agency' : ''}` }, acct.is_operator ? 'Operator' : acct.plan === 'agency' ? 'Agency' : acct.plan === 'pro' ? 'Pro' : 'Free plan'),
    unlimited ? ' Unlimited projects' : ` ${acct.owned_count} of ${acct.project_limit} project${acct.project_limit === 1 ? '' : 's'} used`,
    !unlimited && acct.owned_count >= acct.project_limit ? h('a', { class: 'btn btn-sm', href: '#/account' }, 'Upgrade') : null
  );

  const row = (p) =>
    h(
      'a',
      { class: 'row', href: `#/projects/${p.id}` },
      h('div', {}, h('div', { class: 'row-title' }, p.name), h('div', { class: 'hint' }, p.site_url)),
      h('div', { class: 'row-meta' }, p.open_access ? h('span', { class: 'badge' }, 'open feedback') : null, h('span', { class: 'hint' }, fmtDate(p.created_at)))
    );

  const list = mine.length
    ? h('div', { class: 'rows' }, ...mine.map(row))
    : h('p', { class: 'hint' }, 'No projects yet. Create one to get your share link and install instructions.');

  const canCreate = unlimited || acct.owned_count < acct.project_limit;
  const create = h('a', { class: `btn ${canCreate ? '' : 'btn-disabled'}`, href: canCreate ? '#/projects/new' : '#/account' }, canCreate ? 'New project' : 'Upgrade to add projects');

  const sections = [card(h('div', { class: 'head-row' }, h('span', {}, 'Your projects'), create), planLine, list)];
  if (shared.length) sections.push(card(acct.is_operator ? 'All customer projects' : 'Shared with you', h('div', { class: 'rows' }, ...shared.map(row))));
  return h('div', {}, ...sections);
}
