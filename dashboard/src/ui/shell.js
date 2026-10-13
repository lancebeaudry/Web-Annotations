import { h } from './dom.js';
import { APP_VERSION, BRAND_URL } from '../config.js';

function logo() {
  return h('img', { src: 'img/pinpoint-logo.png', alt: 'PinPoint by Avalanche Creative', class: 'logo', width: '573', height: '140' });
}

// Page frame: light sticky header (same look as the landing page), content
// slot, quiet footer.
export function shell(content, { user, active, wide } = {}) {
  const nav = user
    ? h(
        'nav',
        {},
        h('a', { href: '#/projects', class: active === 'projects' ? 'active' : '' }, 'Projects'),
        h('a', { href: '#/account', class: active === 'account' ? 'active' : '' }, 'Account'),
        h('a', { href: '#/signout' }, 'Sign out')
      )
    : h('nav', {}, h('a', { href: 'https://pinpoint.avalanchegr.com/' }, 'About PinPoint'));
  return h(
    'div',
    { class: 'shell' },
    h('header', {}, h('div', { class: 'bar' }, h('a', { class: 'brand', href: '#/projects', 'aria-label': 'PinPoint' }, logo()), nav)),
    h('main', { class: wide ? 'wide' : '' }, content),
    h(
      'footer',
      {},
      h('a', { href: 'terms.html' }, 'Terms'),
      ' · ',
      h('a', { href: 'privacy.html' }, 'Privacy'),
      ' · ',
      h('a', { href: BRAND_URL, target: '_blank', rel: 'noopener' }, 'Avalanche Creative'),
      h('span', { class: 'ver' }, `v${APP_VERSION}`)
    )
  );
}

// A titled panel. `title` may be a string or an element (e.g. a head-row).
export const card = (title, ...body) => h('section', { class: 'card' }, title ? h('div', { class: 'card-head' }, title) : null, h('div', { class: 'card-body' }, ...body));

// Give a card an anchor id so the project page's section nav can jump to it.
export function anchored(id, cardEl) {
  if (cardEl) cardEl.id = id;
  return cardEl;
}

// Page header: title, subtitle, actions on the right.
export function pageHead(title, sub, ...actions) {
  return h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, title), sub ? h('div', { class: 'sub' }, sub) : null), actions.length ? h('div', { class: 'actions' }, ...actions) : null);
}

// The project header shared by Settings, Feedback and Design system: name,
// site, actions, then the three tabs. Design system shows when the project
// has design rules on (or when you're already on it).
export function projectHeader(p, active, { openCount = null, design = false } = {}) {
  const site = p.site_url.replace(/\/$/, '');
  const tab = (key, href, label) => h('a', { class: active === key ? 'on' : '', href, 'aria-current': active === key ? 'page' : null }, label);
  return h('div', {},
    pageHead(p.name, p.site_url, h('a', { class: 'btn btn-ghost', href: '#/projects' }, 'All projects'), h('a', { class: 'btn', href: `${site}/?pinpoint=${p.token}`, target: '_blank', rel: 'noopener' }, 'Open site in PinPoint')),
    h('nav', { class: 'tabs', 'aria-label': 'Project' },
      tab('settings', `#/projects/${p.id}`, 'Settings'),
      tab('feedback', `#/projects/${p.id}/feedback`, openCount == null ? 'Feedback' : `Feedback (${openCount} open)`),
      design || active === 'design' ? tab('design', `#/projects/${p.id}/design`, 'Design system') : null));
}
