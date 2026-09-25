// Owner/staff export: open comments grouped by page, as Markdown ready
// to paste into Claude Code, or raw JSON for scripting. Owners' exports
// end with an agent block (IDs + endpoint) so an AI assistant can reply
// and resolve items — see agentBlock().

import { deviceLabel } from './capture.js';
import { roleLabel, authorName } from './roles.js';
import { isOpenStatus, statusLabel, labelText, effortText } from './status.js';
import { contextSummary } from './screenshot.js';

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
  return `${authorName(comment)} (${roleLabel(comment)}), ${(comment.created_at || '').slice(0, 10)}`;
}

function openRoots(app, scope) {
  return [...app.comments.values()]
    .filter((c) => !c.parent_id && isOpenStatus(c.status))
    .filter((c) => scope === 'page' ? c.page_path === app.pagePath : true)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
}

function repliesOf(app, rootId) {
  return [...app.comments.values()]
    .filter((c) => c.parent_id === rootId)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
}

export function buildMarkdown(app, scope, agent = null) {
  const roots = openRoots(app, scope);
  if (!roots.length) return { text: '', count: 0 };

  const siteHost = (app.project.site_url || location.origin).replace(/^https?:\/\//, '').replace(/\/$/, '');
  const byPage = new Map();
  for (const c of roots) {
    if (c.kind === 'reference' && !c.page_path) continue; // listed in their own section below
    if (!byPage.has(c.page_path)) byPage.set(c.page_path, []);
    byPage.get(c.page_path).push(c);
  }

  const blocks = [
    `# Feedback — ${siteHost}`,
    '_Exported from PinPoint by Avalanche — https://avalanchegr.com_',
    '',
  ];
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
      if (c.status && c.status !== 'open') lines.push(`   - Status: ${statusLabel(c.status)}`);
      if (c.labels && c.labels.length) lines.push(`   - Labels: ${c.labels.map(labelText).join(', ')}`);
      if (c.kind === 'reference' && c.source) lines.push(...sourceLines(c.source));
      if (c.effort) lines.push(`   - Effort: ${effortText(c.effort)}`);
      if (c.assignee_email) lines.push(`   - Assigned to: ${c.assignee_email}`);
      const ctx = contextSummary(c.context);
      if (ctx) lines.push(`   - Reviewer's browser: ${ctx}`);
      for (const e of ((c.context && c.context.errors) || []).slice(0, 5)) lines.push(`     - console: ${e.msg}`);
      if (agent) lines.push(`   - ID: ${c.id}`);
      if (c.attachments && c.attachments.length) {
        lines.push(`   - Attachments: ${c.attachments.map((a) => a.url).join(', ')}`);
      }
      lines.push(`   - — ${authorLine(app, c)}`);
      for (const r of repliesOf(app, c.id)) {
        lines.push(`   - Reply (${authorLine(app, r)}): ${r.comment_text}`);
      }
      lines.push('');
    });
    blocks.push(lines.join('\n'));
  }
  const refs = roots.filter((c) => c.kind === 'reference' && !c.page_path);
  if (refs.length) {
    const lines = ['## References from other sites  (not yet tied to an element here)', ''];
    refs.forEach((c, i) => {
      lines.push(`${i + 1}. **${c.comment_text}**`);
      lines.push(...sourceLines(c.source || {}));
      if (c.labels && c.labels.length) lines.push(`   - Labels: ${c.labels.map(labelText).join(', ')}`);
      if (agent) lines.push(`   - ID: ${c.id}`);
      lines.push(`   - — ${authorLine(app, c)}`);
      lines.push('');
    });
    blocks.push(lines.join('\n'));
  }
  const triage = triageSummary(roots);
  if (triage) blocks.splice(3, 0, triage);
  if (agent) blocks.push(agentBlock(agent));
  return { text: blocks.join('\n'), count: roots.length };
}

// Where a reference came from, for a developer or an assistant to imitate.
function sourceLines(s) {
  const out = [];
  if (s.url) out.push(`   - Reference: ${s.url}`);
  if (s.screenshot) out.push(`   - Reference screenshot: ${s.screenshot}`);
  if (s.text) out.push(`   - Reference text: "${String(s.text).slice(0, 200)}"`);
  const st = Object.entries(s.styles || {}).map(([k, v]) => `${k}: ${v}`).join('; ');
  if (st) out.push(`   - Reference styles: ${st}`);
  return out;
}

// A short "who owns what" summary at the top of the export, built from the
// triage fields when any are set: waiting on the client, then by effort.
function triageSummary(roots) {
  const triaged = roots.filter((c) => c.status === 'waiting' || c.effort || (c.labels && c.labels.length));
  if (!triaged.length) return '';
  const groups = [
    ['Waiting on the client', roots.filter((c) => c.status === 'waiting')],
    ['Quick wins', roots.filter((c) => c.status !== 'waiting' && c.effort === 'quick')],
    ['Medium', roots.filter((c) => c.status !== 'waiting' && c.effort === 'medium')],
    ['Large', roots.filter((c) => c.status !== 'waiting' && c.effort === 'large')],
    ['Photos and content needed', roots.filter((c) => c.status !== 'waiting' && !c.effort && (c.labels || []).some((l) => l === 'photo' || l === 'content'))],
  ].filter(([, list]) => list.length);
  const lines = ['## Summary', ''];
  for (const [title, list] of groups) {
    lines.push(`**${title} — ${list.length}**`);
    for (const c of list) lines.push(`- ${c.page_path}: ${c.comment_text.split('\n')[0].slice(0, 90)}${(c.labels || []).length ? ` (${c.labels.map(labelText).join(', ')})` : ''}`);
    lines.push('');
  }
  return lines.join('\n');
}

// Appended to owner/operator exports: the IDs above plus a key and an
// endpoint let an AI coding assistant reply to and resolve items itself,
// instead of the human copying status back by hand. Kept as plain curl so
// any assistant that can run a shell command can use it.
export function agentBlock({ key, endpoint }) {
  return [
    '---',
    '## For AI coding assistants (Claude Code, Cursor, …)',
    '',
    'These items are tracked in PinPoint and each one has an ID above. Triage anything untriaged first: labels (bug, copy, design, content, photo, decision), effort (quick, medium, large), and status "waiting" with a reply when the client must decide or supply something. Then work through what you own, quick items first.',
    'When you finish an item, mark it resolved with a one-line reply saying what you changed.',
    "If you cannot do an item, reply with why and leave it open. Never resolve an item you did not complete.",
    'Before you report that you are done, fetch the open list again and confirm nothing you handled is still open.',
    '',
    'Resolve with a note:',
    '```bash',
    `curl -s -X POST "${endpoint}" -H "content-type: application/json" -H "x-pinpoint-agent-key: ${key}" \\`,
    `  -d '{"comment_id":"<ID>","reply":"Changed the headline to …","resolve":true,"agent_name":"Claude Code"}'`,
    '```',
    '',
    'Triage an item (labels: bug, copy, design, content, photo, decision; effort: quick, medium, large) or hand it to the client:',
    '```bash',
    `curl -s -X POST "${endpoint}" -H "content-type: application/json" -H "x-pinpoint-agent-key: ${key}" \\`,
    `  -d '{"comment_id":"<ID>","labels":["photo"],"effort":"quick","status":"waiting","reply":"Need the new team photo from you before I can place it."}'`,
    '```',
    'Reply without resolving (blocked, question, partial):',
    '```bash',
    `curl -s -X POST "${endpoint}" -H "content-type: application/json" -H "x-pinpoint-agent-key: ${key}" \\`,
    `  -d '{"comment_id":"<ID>","reply":"Could not change this because …"}'`,
    '```',
    'List what is still open (JSON):',
    '```bash',
    `curl -s "${endpoint}?status=open" -H "x-pinpoint-agent-key: ${key}"`,
    '```',
    'Prefer MCP? Claude Code can use PinPoint as a tool server (list_feedback, reply, set_status, assign):',
    '```bash',
    `claude mcp add --transport http pinpoint "${endpoint.replace(/\/agent$/, '/mcp')}" --header "x-pinpoint-agent-key: ${key}"`,
    '```',
    'The key is private to this project. Do not commit it; keep it in your shell environment or a local, gitignored file.',
    '',
  ].join('\n');
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
