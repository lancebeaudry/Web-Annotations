import { h, fmtDate } from '../ui/dom.js';
import { pageHead } from '../ui/shell.js';
import { listProjects, account, openCounts } from '../api.js';

const PLAN = { free: 'Free plan', pro: 'Pro', agency: 'Agency' };
const VIEW_KEY = 'pp.projects.view';

// Hosts we never send to an outside favicon/screenshot service: local dev,
// private networks and staging hosts that sit behind HTTP auth.
function isPrivateHost(host) {
  return (
    !host.includes('.') ||
    /\.(local|localhost|test|internal|lan|example)$/i.test(host) ||
    /\.(wpenginepowered|wpengine|kinsta\.cloud|flywheelsites|pantheonsite)\.(com|io)$/i.test(host) ||
    /^(localhost|127\.|10\.|192\.168\.|0\.0\.0\.0)/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}
const hostOf = (url) => { try { return new URL(url).host; } catch { return url.replace(/^https?:\/\//, '').split('/')[0]; } };
const placeholderIcon = () =>
  h('span', { class: 'fav fav-empty', 'aria-hidden': 'true' },
    h('span', {}, ''));

// Favicon via Google's public favicon endpoint for public hosts; a neutral
// tile for private ones or when nothing comes back.
function favicon(p) {
  const host = hostOf(p.site_url);
  if (isPrivateHost(host)) return placeholderIcon();
  const img = h('img', { class: 'fav', src: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`, alt: '', width: '20', height: '20', loading: 'lazy' });
  img.addEventListener('error', () => img.replaceWith(placeholderIcon()));
  return img;
}

// Home page screenshot for the card view. WordPress.com's mShots service is
// free and needs no key; it returns a "generating" image on the first request
// and the real capture on later ones.
function shot(p) {
  const host = hostOf(p.site_url);
  const wrap = h('div', { class: 'shot' });
  if (isPrivateHost(host)) { wrap.classList.add('shot-empty'); wrap.append(h('span', {}, 'No preview for private sites')); return wrap; }
  const base = `https://s.wordpress.com/mshots/v1/${encodeURIComponent(p.site_url)}?w=800&h=500`;
  const img = h('img', { src: base, alt: `${p.name} home page`, loading: 'lazy' });
  img.addEventListener('error', () => { wrap.classList.add('shot-empty'); wrap.replaceChildren(h('span', {}, 'Preview unavailable')); });
  // First request returns a "generating" placeholder; fetch again a couple of
  // times so the real capture shows up without a manual reload.
  let tries = 0;
  const again = () => { if (++tries > 3 || !img.isConnected) return; img.src = `${base}&r=${Date.now()}`; setTimeout(again, 8000 * tries); };
  setTimeout(again, 6000);
  wrap.append(img);
  return wrap;
}

export async function projectsScreen({ user }) {
  const [projects, acct, counts] = await Promise.all([listProjects(), account(), openCounts().catch(() => ({}))]);
  const mine = projects.filter((p) => p.owner_id === user.id);
  const shared = projects.filter((p) => p.owner_id !== user.id);
  const unlimited = acct.project_limit >= 2147483647;
  const canCreate = unlimited || acct.owned_count < acct.project_limit;
  let view = 'table';
  try { view = localStorage.getItem(VIEW_KEY) || 'table'; } catch {}

  const planLine = h(
    'div',
    { class: 'plan-line' },
    h('span', { class: `badge ${acct.plan === 'pro' ? 'badge-pro' : acct.plan === 'agency' ? 'badge-agency' : ''}` }, acct.is_operator ? 'Operator' : PLAN[acct.plan] || 'Free plan'),
    unlimited ? 'Unlimited projects' : `${acct.owned_count} of ${acct.project_limit} project${acct.project_limit === 1 ? '' : 's'} used`,
    !unlimited && acct.owned_count >= acct.project_limit ? h('a', { href: '#/account' }, 'Upgrade for more') : null
  );

  const openLabel = (p) => { const n = counts[p.id] || 0; return n ? `${n} open` : 'Nothing open'; };

  const card = (p) =>
    h(
      'a',
      { class: 'pcard', href: `#/projects/${p.id}` },
      shot(p),
      h('div', { class: 'pcard-body' },
        h('div', { class: 'name' }, favicon(p), h('span', {}, p.name)),
        h('div', { class: 'url' }, hostOf(p.site_url)),
        h('div', { class: 'meta' },
          h('span', { class: 'open' }, openLabel(p)),
          p.open_access ? h('span', { class: 'badge badge-ok' }, 'open feedback') : null,
          h('span', {}, `since ${fmtDate(p.created_at)}`)))
    );

  const table = (list) =>
    h('div', { class: 'table-wrap' },
      h('table', { class: 'ptable' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Project'), h('th', {}, 'Feedback'), h('th', {}, 'Access'), h('th', {}, 'Added'), h('th', {}, ''))),
        h('tbody', {}, ...list.map((p) => {
          const tr = h('tr', { tabindex: '0', role: 'link' },
            h('td', {}, h('div', { class: 'pname' }, favicon(p), h('div', {}, h('div', { class: 'row-title' }, p.name), h('div', { class: 'hint' }, hostOf(p.site_url))))),
            h('td', {}, h('span', { class: counts[p.id] ? 'open' : 'hint' }, openLabel(p))),
            h('td', {}, p.open_access ? h('span', { class: 'badge badge-ok' }, 'open feedback') : h('span', { class: 'hint' }, 'invite only')),
            h('td', { class: 'hint' }, fmtDate(p.created_at)),
            h('td', { class: 'acts' },
              h('a', { class: 'btn btn-ghost btn-sm', href: `#/projects/${p.id}/feedback` }, 'Feedback'),
              h('a', { class: 'btn btn-ghost btn-sm', href: `${p.site_url.replace(/\/$/, '')}/?markup=${p.token}`, target: '_blank', rel: 'noopener' }, 'Open site')));
          const go = () => { location.hash = `#/projects/${p.id}`; };
          tr.addEventListener('click', (e) => { if (!e.target.closest('a')) go(); });
          tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.target.closest('a')) go(); });
          return tr;
        }))));

  const render = (list) => (view === 'cards' ? h('div', { class: 'grid' }, ...list.map(card)) : table(list));

  const seg = h('div', { class: 'seg' });
  const body = h('div', {});
  function draw() {
    seg.replaceChildren(...[['table', 'Table'], ['cards', 'Cards']].map(([v, label]) => {
      const b = h('button', { type: 'button', class: v === view ? 'on' : '' }, label);
      b.addEventListener('click', () => { view = v; try { localStorage.setItem(VIEW_KEY, v); } catch {} draw(); });
      return b;
    }));
    const parts = [mine.length ? render(mine) : h('div', { class: 'empty' }, 'No projects yet. Create one to get your share link and install instructions.')];
    if (shared.length) parts.push(h('h3', { class: 'section-title' }, acct.is_operator ? 'All customer projects' : 'Shared with you'), render(shared));
    body.replaceChildren(...parts);
  }
  draw();

  const create = h('a', { class: `btn ${canCreate ? '' : 'btn-disabled'}`, href: canCreate ? '#/projects/new' : '#/account' }, canCreate ? 'New project' : 'Upgrade to add projects');
  return h('div', {}, pageHead('Projects', planLine, seg, create), body);
}
