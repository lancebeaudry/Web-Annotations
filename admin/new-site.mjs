// Register a new client site in one command:
//   node admin/new-site.mjs "Site Name" https://clientsite.com
//
// Does both onboarding steps automatically:
//   1. Inserts the projects row (service-role key bypasses RLS — that
//      key is admin-only and must never ship in markup.js).
//   2. Adds SITE_URL/** to the auth redirect allowlist via the
//      Supabase Management API (personal access token).
//
// Prints the embed line and the share link when done.
import { readFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

function loadEnv() {
  const env = {};
  const path = new URL('../.env', import.meta.url);
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return env;
}

const env = loadEnv();
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ACCESS_TOKEN } = env;

const [name, rawUrl] = process.argv.slice(2);
if (!name || !rawUrl) {
  console.error('Usage: node admin/new-site.mjs "Site Name" https://clientsite.com');
  process.exit(1);
}
for (const [key, hint] of [
  ['SUPABASE_URL', 'project URL'],
  ['SUPABASE_SERVICE_ROLE_KEY', 'service role key (Settings -> API Keys)'],
  ['SUPABASE_ACCESS_TOKEN', 'personal access token (account -> Access Tokens)'],
]) {
  if (!env[key]) {
    console.error(`Missing ${key} in .env — add the ${hint} first.`);
    process.exit(1);
  }
}

const siteUrl = rawUrl.replace(/\/+$/, '');
if (!/^https?:\/\//.test(siteUrl)) {
  console.error(`Site URL must start with http:// or https:// (got "${rawUrl}")`);
  process.exit(1);
}
const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const token = `${slug}-${randomBytes(4).toString('hex')}`;
const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0];

async function fail(step, res) {
  console.error(`${step} failed (HTTP ${res.status}): ${await res.text()}`);
  process.exit(1);
}

// -- Step 1: insert the projects row ------------------------------
const dupe = await fetch(
  `${SUPABASE_URL}/rest/v1/projects?site_url=eq.${encodeURIComponent(siteUrl)}&select=token,name`,
  { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
);
if (!dupe.ok) await fail('Duplicate check', dupe);
const existing = await dupe.json();

let activeToken = token;
if (existing.length) {
  activeToken = existing[0].token;
  console.log(`Already registered as "${existing[0].name}" — reusing its token.`);
} else {
  const ins = await fetch(`${SUPABASE_URL}/rest/v1/projects`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ token, name, site_url: siteUrl }),
  });
  if (!ins.ok) await fail('Project insert', ins);
  console.log(`Registered "${name}".`);
}

// -- Step 2: add SITE_URL/** to the auth redirect allowlist --------
const AUTH_CONFIG = `https://api.supabase.com/v1/projects/${projectRef}/config/auth`;
const mgmtHeaders = { Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' };

const cfgRes = await fetch(AUTH_CONFIG, { headers: mgmtHeaders });
if (!cfgRes.ok) await fail('Auth config fetch', cfgRes);
const cfg = await cfgRes.json();

const list = (cfg.uri_allow_list || '').split(',').map((s) => s.trim()).filter(Boolean);
const entry = `${siteUrl}/**`;
if (list.includes(entry)) {
  console.log('Redirect URL already allowed.');
} else {
  list.push(entry);
  const patch = await fetch(AUTH_CONFIG, {
    method: 'PATCH',
    headers: mgmtHeaders,
    body: JSON.stringify({ uri_allow_list: list.join(',') }),
  });
  if (!patch.ok) await fail('Redirect allowlist update', patch);
  console.log(`Allowed sign-in links to return to ${siteUrl}`);
}

// -- Done -----------------------------------------------------------
console.log(`
Embed line for the site's <head> (WordPress: enqueue from the child theme):

  <script defer src="https://YOUR_HOST/markup.js" data-project="${activeToken}"></script>

Share link for the client:

  ${siteUrl}/?markup=${activeToken}
`);
