// Avalanche branding for PinPoint — the one place the mark, the link and the UTM live.
// Everything renders inside the overlay's shadow DOM, so host-site CSS
// can't touch it.
import { h } from './overlay.js';
import { MARKUP_VERSION } from '../config.js';

export const BRAND_URL = 'https://pinpoint.avalanchegr.com/';

export function brandHref(campaign, medium = 'tool') {
  return `${BRAND_URL}?utm_source=pinpoint&utm_medium=${medium}&utm_campaign=${encodeURIComponent(campaign)}`;
}

// The PinPoint pin mark, embedded so it renders inside the shadow DOM
// with no network request. 64px PNG, shown at 14–16px.
const MARK_DATA = 'data:image/png;base64,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';
export function brandMark(size = 16) {
  const img = document.createElement('img');
  img.src = MARK_DATA;
  img.width = size;
  img.height = size;
  img.alt = '';
  img.setAttribute('aria-hidden', 'true');
  img.style.cssText = 'display:block;flex:none;';
  return img;
}

// Linked wordmark for the toolbar. Opens the site in a new tab and leaves
// the review tab (and its session) alone.
export function brandLink(campaign) {
  return h(
    'a',
    {
      class: 'toolbar-brand',
      href: brandHref(campaign),
      target: '_blank',
      rel: 'noopener',
      title: `PinPoint v${MARKUP_VERSION} — by Avalanche Creative`,
    },
    brandMark(16),
    h('span', { class: 'brand-text' }, 'PinPoint')
  );
}

// Small credit line for card footers — every reviewer sees the guest/auth
// card before they can comment, so this is the highest-visibility spot.
export function poweredBy(campaign) {
  return h(
    'div',
    { class: 'powered-by' },
    'Powered by ',
    h('a', { href: brandHref(campaign), target: '_blank', rel: 'noopener' }, 'Avalanche')
  );
}
