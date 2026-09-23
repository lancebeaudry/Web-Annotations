// Avalanche branding for PinPoint — the one place the mark, the link and the UTM live.
// Everything renders inside the overlay's shadow DOM, so host-site CSS
// can't touch it.
import { h } from './overlay.js';
import { MARKUP_VERSION } from '../config.js';

export const BRAND_URL = 'https://avalanchegr.com/';

export function brandHref(campaign, medium = 'tool') {
  return `${BRAND_URL}?utm_source=pinpoint&utm_medium=${medium}&utm_campaign=${encodeURIComponent(campaign)}`;
}

// The Avalanche mark (two peaks), embedded so it renders inside the
// shadow DOM with no network request. 64px PNG, shown at 14–16px.
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
