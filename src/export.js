// Team-only export: open comments grouped by page, as Markdown ready
// to paste into Claude Code, or raw JSON for scripting.

import { deviceLabel } from './capture.js';

function rgbToHex(value) {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(value || '');
  if (!m) return value;
  if (m[4] !== undefined && parseFloat(m[4]) === 0) return 'transparent';
  const hex = [m[1], m[2], m[3]]
    .map((n) => Number(n).toString(16).padStart(2, '0'))
    .join('');
  return `#${hex}`;
}

function stylesLine(styles) {
  if (!styles) return null;
  const parts = [];
  if (styles.fontSize) parts.push(`font-size ${styles.fontSize}`);
  if (styles.fontWeight) parts.push(`font-weight ${styles.fontWeight}`);
  if (styles.color) parts.push(`color ${rgbToHex(styles.color)}`);
  if (styles.backgroundColor && rgbToHex(styles.backgroundColor) !== 'transparent') {
    parts.push(`background ${rgbToHex(styles.backgroundColor)}`);
  }
  if (styles.textAlign && styles.textAlign !== 'start' && styles.textAlign !== 'left') {
    parts.push(`text-align ${styles.textAlign}`);
  }
  return parts.length ? parts.join(', ') : null;
}

function label(comment) {
  const fb = comment.selector_fallback || {};
  if (fb.nearbyLandmark) return fb.nearbyLandmark.replace(/^#/, 'in #');
  const text = (comment.current_text || '').trim();
  if (text) return `"${text.slice(0, 40)}${text.length > 40 ? '…' : ''}"`;
  return comment.selector || 'element';
}

function authorLine(app, comment) {
  const name = comment.author_name || comment.author_email;
  const isTeam = comment.author_email.toLowerCase().endsWith(`@${app.teamDomain}`);
  return `${name} (${isTeam ? 'Avalanche' : 'client'}), ${(comment.created_at || '').slice(0, 10)}`;
}

function openRoots(app, scope) {
  return [...app.comments.values()]
    .filter((c) => !c.parent_id && c.status === 'open')
    .filter((c) => scope === 'page' ? c.page_path === app.pagePath : true)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
}

function repliesOf(app, rootId) {
  return [...app.comments.values()]
    .filter((c) => c.parent_id === rootId)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
}

export function buildMarkdown(app, scope) {
  const roots = openRoots(app, scope);
  if (!roots.length) return { text: '', count: 0 };

  const siteHost = (app.project.site_url || location.origin).replace(/^https?:\/\//, '').replace(/\/$/, '');
  const byPage = new Map();
  for (const c of roots) {
    if (!byPage.has(c.page_path)) byPage.set(c.page_path, []);
    byPage.get(c.page_path).push(c);
  }

  const blocks = [];
  for (const [path, comments] of byPage) {
    const lines = [`## Feedback: ${path}  (${siteHost}${path === '/' ? '' : path})`, ''];
    comments.forEach((c, i) => {
      lines.push(`${i + 1}. **<${c.element_tag || '?'}> — ${label(c)}**`);
      const device = deviceLabel(c.viewport_w);
      if (device) lines.push(`   - Viewport: ${device} (${c.viewport_w}px wide)`);
      if (c.selector) lines.push(`   - Selector: \`${c.selector}\``);
      if (c.current_text) lines.push(`   - Current text: "${c.current_text}"`);
      const styles = stylesLine(c.computed_styles);
      if (styles) lines.push(`   - Current styles: ${styles}`);
      lines.push(`   - Requested change: ${c.comment_text}`);
      lines.push(`   - — ${authorLine(app, c)}`);
      for (const r of repliesOf(app, c.id)) {
        lines.push(`   - Reply (${authorLine(app, r)}): ${r.comment_text}`);
      }
      lines.push('');
    });
    blocks.push(lines.join('\n'));
  }
  return { text: blocks.join('\n'), count: roots.length };
}

export function buildJson(app, scope) {
  const roots = openRoots(app, scope);
  const data = roots.map((c) => ({ ...c, replies: repliesOf(app, c.id) }));
  return { text: JSON.stringify(data, null, 2), count: roots.length };
}

export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API can be blocked outside secure contexts; fall back.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
