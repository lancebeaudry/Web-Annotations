// Avalanche branding — the one place the mark, the link and the UTM live.
// Everything renders inside the overlay's shadow DOM, so host-site CSS
// can't touch it.
import { h } from './overlay.js';
import { MARKUP_VERSION } from '../config.js';

export const BRAND_URL = 'https://avalanchegr.com/';

export function brandHref(campaign, medium = 'tool') {
  return `${BRAND_URL}?utm_source=markup&utm_medium=${medium}&utm_campaign=${encodeURIComponent(campaign)}`;
}

// Fill-based mark: two peaks (an "A" and a mountain) in Alpine Sky with a
// Glacial Ice cap. PLACEHOLDER until the real Avalanche SVG is supplied —
// swapping it is a one-path change here.
export function brandMark(size = 16) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const peaks = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  peaks.setAttribute('d', 'M2 20 L9 6 L13 13 L15.5 9.5 L22 20 Z');
  peaks.setAttribute('fill', 'currentColor');
  const cap = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  cap.setAttribute('d', 'M9 6 L11 9.5 L7.5 9.5 Z');
  cap.setAttribute('fill', '#9BE3FF');
  svg.append(peaks, cap);
  return svg;
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
      title: `Avalanche Markup v${MARKUP_VERSION} — by Avalanche Creative`,
    },
    brandMark(16),
    h('span', { class: 'brand-text' }, 'Avalanche Markup')
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
