import { h } from './dom.js';
import { APP_VERSION, BRAND_URL } from '../config.js';

function logo() {
  return h('img', { src: 'img/pinpoint-logo-white.png', alt: 'PinPoint by Avalanche Creative', class: 'logo', width: '573', height: '140' });
}

function mark() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('aria-hidden', 'true');
  const a = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  a.setAttribute('d', 'M2 20 L9 6 L13 13 L15.5 9.5 L22 20 Z');
  a.setAttribute('fill', 'currentColor');
  const b = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  b.setAttribute('d', 'M9 6 L11 9.5 L7.5 9.5 Z');
  b.setAttribute('fill', '#9BE3FF');
  svg.append(a, b);
  return svg;
}

// Page frame: header with nav, content slot, footer.
export function shell(content, { user, active } = {}) {
  const nav = user
    ? h(
        'nav',
        {},
        h('a', { href: '#/projects', class: active === 'projects' ? 'active' : '' }, 'Projects'),
        h('a', { href: '#/account', class: active === 'account' ? 'active' : '' }, 'Account'),
        h('a', { href: '#/signout' }, 'Sign out')
      )
    : null;
  return h(
    'div',
    { class: 'shell' },
    h(
      'header',
      {},
      h('a', { class: 'brand', href: '#/projects' }, logo()),
      nav
    ),
    h('main', {}, content),
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

export const card = (title, ...body) => h('section', { class: 'card' }, title ? h('div', { class: 'card-head' }, title) : null, h('div', { class: 'card-body' }, ...body));
