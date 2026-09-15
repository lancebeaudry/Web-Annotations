#!/usr/bin/env node
// Publish the built dashboard (dist/app/*) to GitHub Pages, and optionally
// the overlay bundle (--bundle) to the public `markup` bucket.
//
//   node build-app.mjs && node admin/deploy-app.mjs            # dashboard
//   node admin/deploy-app.mjs --bundle                         # also dist/markup.js
// Also publishes landing/ to <DASHBOARD_URL>landing/ (marketing page).
//
// Why Pages: supabase.co refuses to serve text/html anywhere (Storage AND
// edge functions rewrite it to text/plain with a sandbox CSP), so the
// dashboard lives in a separate, public, compiled-only repository:
//   https://github.com/lancebeaudry/avalanche-markup-app  ->  DASHBOARD_URL
// It contains no source and no secrets. A custom domain later is a CNAME
// file + DNS.
//
// Uses git directly (execFileSync, no shell). The working clone lives in
// .deploy/pages (gitignored).

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, mkdirSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)); // the folder name has a space
const PAGES_REPO = 'https://github.com/lancebeaudry/avalanche-markup-app.git';
const CLONE = join(ROOT, '.deploy', 'pages');

function loadEnv() {
  const env = {};
  const p = join(ROOT, '.env');
  if (!existsSync(p)) return env;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}
const env = loadEnv();
const git = (args, cwd = CLONE) => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
const sha = (b) => createHash('sha256').update(b).digest('hex');

const dist = join(ROOT, 'dist', 'app');
if (!existsSync(dist)) { console.error('dist/app missing — run `node build-app.mjs` first'); process.exit(1); }

// ---- dashboard -> GitHub Pages
mkdirSync(join(ROOT, '.deploy'), { recursive: true });
if (!existsSync(join(CLONE, '.git'))) {
  execFileSync('git', ['clone', '-q', PAGES_REPO, CLONE], { stdio: 'pipe' });
} else {
  git(['fetch', '-q', 'origin']);
  git(['reset', '-q', '--hard', 'origin/main']);
}
for (const f of readdirSync(CLONE)) if (f !== '.git') rmSync(join(CLONE, f), { recursive: true, force: true });
cpSync(dist, CLONE, { recursive: true });
// The marketing page rides along at /landing/ (the clone is wiped each deploy).
cpSync(join(ROOT, 'landing'), join(CLONE, 'landing'), { recursive: true });
writeFileSync(join(CLONE, '.nojekyll'), '');
writeFileSync(join(CLONE, 'README.md'),
  '# Avalanche Markup — dashboard\n\nCompiled customer dashboard for [Avalanche Markup](https://avalanchegr.com), published via GitHub Pages. Source is private. Contains no secrets (the Supabase anon key is public by design; access is enforced by row-level security).\n');
git(['add', '-A']);
const version = readFileSync(join(dist, 'index.html'), 'utf8').match(/data-version="([^"]+)"/)?.[1] || 'unknown';
if (git(['status', '--porcelain'])) {
  git(['commit', '-q', '-m', `Deploy dashboard ${version}`]);
  git(['push', '-q', 'origin', 'main']);
  console.log(`✔ dashboard ${version} pushed to Pages (live in ~1 min): ${env.DASHBOARD_URL || 'https://lancebeaudry.github.io/avalanche-markup-app/'}`);
} else {
  console.log('✔ dashboard unchanged — nothing to publish');
}

// ---- overlay bundle -> bucket (optional)
if (process.argv.includes('--bundle')) {
  const URL_ = env.SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!URL_ || !KEY) { console.error('.env needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for --bundle'); process.exit(1); }
  const buf = readFileSync(join(ROOT, 'dist', 'markup.js'));
  const r = await fetch(`${URL_}/storage/v1/object/markup/markup.js`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/javascript', 'Cache-Control': 'public, max-age=60', 'x-upsert': 'true' },
    body: buf,
  });
  if (!r.ok) throw new Error(`upload markup.js: ${r.status} ${await r.text()}`);
  const v = await fetch(`${URL_}/storage/v1/object/public/markup/markup.js?v=${Date.now()}`);
  if (sha(Buffer.from(await v.arrayBuffer())) !== sha(buf)) throw new Error('verify markup.js: bytes differ');
  console.log('✔ markup.js uploaded to the bucket and verified');
}
