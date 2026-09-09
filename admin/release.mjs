#!/usr/bin/env node
// Avalanche Markup — release script.
//
//   node admin/release.mjs <version> --changelog "…" [--marker "…"]… [--dry-run] [--no-push]
//   npm run release -- 2.0.0 --changelog "…" --marker "Powered by"
//
// Does the whole release ritual deterministically and fails hard at the
// first problem. Nothing is uploaded until every local check has passed,
// and the producing commit exists before any artifact leaves the machine.
//
//   1. preflight    clean tree, on main, version > current, .env, zip tools,
//                   versioned package not already published (immutability)
//   2. build        real + mock bundles with MARKUP_VERSION=<v>
//   3. verify       dist/markup.js carries the literal version, the .env
//                   Supabase URL, every --marker, no mock config, > 100 KB
//                   (this is what stops a stale bundle from shipping)
//   4. stage        copy the bundle into the plugin; byte-compare
//   5. bump         plugin Version: header, update.json version/url/changelog
//   6. package      build the zip; verify its listing and the bundle inside
//   7. commit+tag   (dry-run stops before this and leaves the tree modified)
//   8. upload       to the public `markup` bucket in dependency order —
//                   the manifest goes LAST because it is the switch
//   9. push
//
// Every external command is invoked directly (execFileSync with an argv
// array) — no shell — so there is no quoting to get wrong and it runs in
// restricted environments that don't expose /bin/sh.
//
// Distribution lives in Supabase Storage (see supabase/distribution.sql):
//   markup.js                        60s cache, overwritten each release
//   markup-<v>.js                    immutable
//   plugin/update.json               60s cache — polled by every WP site
//   plugin/avalanche-markup-<v>.zip  immutable — the download_url
//   plugin/avalanche-markup.zip      60s cache — versionless alias

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, copyFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const PLUGIN_DIR = join(ROOT, 'wordpress-plugin');
const PLUGIN_PHP = join(PLUGIN_DIR, 'avalanche-markup', 'avalanche-markup.php');
const PLUGIN_JS = join(PLUGIN_DIR, 'avalanche-markup', 'markup.js');
const MANIFEST = join(PLUGIN_DIR, 'update.json');
const ZIP = join(PLUGIN_DIR, 'avalanche-markup.zip');
const DIST_JS = join(ROOT, 'dist', 'markup.js');
const BUCKET = 'markup';

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const version = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--changelog' && argv[i - 1] !== '--marker');
const flag = (name) => argv.includes(name);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const markers = argv.flatMap((a, i) => (a === '--marker' ? [argv[i + 1]] : [])).filter(Boolean);
const changelog = opt('--changelog');
const dryRun = flag('--dry-run');
const noPush = flag('--no-push');

const die = (msg) => {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
};
const ok = (msg) => console.log(`✔ ${msg}`);
const step = (msg) => console.log(`\n── ${msg}`);
// Direct invocation, no shell. Returns trimmed stdout ('' when inherited).
const run = (file, args = [], opts = {}) => {
  const out = execFileSync(file, args, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', ...opts });
  return typeof out === 'string' ? out.trim() : '';
};

if (!version) die('usage: node admin/release.mjs <version> --changelog "…" [--marker "…"] [--dry-run] [--no-push]');
if (!/^\d+\.\d+\.\d+$/.test(version)) die(`"${version}" is not a plain semver x.y.z`);
if (!changelog && !dryRun) die('--changelog "…" is required (it goes into update.json and the commit)');

// ---------------------------------------------------------------- env
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
const SUPABASE_URL = env.SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const PUB = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}`;

const semverGt = (a, b) => {
  const A = a.split('.').map(Number), B = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (A[i] !== B[i]) return A[i] > B[i];
  return false;
};
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ---------------------------------------------------------------- 1. preflight
step(`Preflight for v${version}${dryRun ? ' (dry run)' : ''}`);
if (run('git', ['status', '--porcelain'])) die('working tree is not clean — commit or stash first');
if (run('git', ['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') die('not on main');
const phpNow = readFileSync(PLUGIN_PHP, 'utf8').match(/^\s*\*\s*Version:\s*([\d.]+)/m)?.[1];
const manifestNow = JSON.parse(readFileSync(MANIFEST, 'utf8'));
if (!phpNow) die('could not read Version: from the plugin header');
if (!semverGt(version, phpNow)) die(`version ${version} is not greater than plugin header ${phpNow}`);
if (!semverGt(version, manifestNow.version)) die(`version ${version} is not greater than update.json ${manifestNow.version}`);
if (!SUPABASE_URL || !SERVICE_KEY) die('.env needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
for (const tool of ['zip', 'unzip']) {
  try { run('which', [tool]); } catch { die(`${tool} not on PATH`); }
}
const zipKey = `plugin/avalanche-markup-${version}.zip`;
{
  const r = await fetch(`${PUB}/${zipKey}?v=${Date.now()}`);
  if (r.status === 200) die(`${zipKey} is already published — versions are immutable; pick a new version`);
}
ok(`clean tree on main; ${phpNow} → ${version}; package not yet published`);

// ---------------------------------------------------------------- 2. build
step('Build');
const buildEnv = { ...process.env, MARKUP_VERSION: version };
run('node', ['build.mjs'], { env: buildEnv, stdio: 'inherit' });
run('node', ['build.mjs', '--mock'], { env: buildEnv, stdio: 'inherit' });

// ---------------------------------------------------------------- 3. verify bundle
step('Verify bundle');
const js = readFileSync(DIST_JS, 'utf8');
if (!js.includes(`"${version}"`)) die(`dist/markup.js does not contain the version literal "${version}" — stale build?`);
if (!js.includes(SUPABASE_URL)) die('dist/markup.js does not contain the .env SUPABASE_URL');
if (js.includes('mock://local')) die('dist/markup.js contains mock config');
if (js.length < 100 * 1024) die(`dist/markup.js is only ${js.length} bytes`);
for (const m of markers) {
  if (!js.includes(m)) die(`marker not found in dist/markup.js: ${JSON.stringify(m)}`);
}
ok(`bundle ${(js.length / 1024).toFixed(1)} KB, version literal + URL present${markers.length ? `, markers: ${markers.map((m) => JSON.stringify(m)).join(', ')}` : ''}`);

// ---------------------------------------------------------------- 4. stage into plugin
step('Stage bundle into plugin');
copyFileSync(DIST_JS, PLUGIN_JS);
if (!readFileSync(PLUGIN_JS).equals(readFileSync(DIST_JS))) die('plugin markup.js differs from dist after copy');
ok('wordpress-plugin/avalanche-markup/markup.js == dist/markup.js');

// ---------------------------------------------------------------- 5. bump
step('Bump versions');
let php = readFileSync(PLUGIN_PHP, 'utf8');
php = php.replace(/^(\s*\*\s*Version:\s*)[\d.]+/m, `$1${version}`);
writeFileSync(PLUGIN_PHP, php);
const manifest = {
  ...manifestNow,
  version,
  download_url: `${PUB}/${zipKey}`,
  changelog: changelog ? `${version} — ${changelog}` : manifestNow.changelog,
};
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
ok(`plugin header + update.json → ${version}; download_url → ${manifest.download_url}`);

// ---------------------------------------------------------------- 6. package
step('Package');
rmSync(ZIP, { force: true });
// zip applies the -x pattern itself; no shell involved.
run('zip', ['-rq', 'avalanche-markup.zip', 'avalanche-markup', '-x', '*.DS_Store'], { cwd: PLUGIN_DIR });
const listing = run('unzip', ['-Z1', 'avalanche-markup.zip'], { cwd: PLUGIN_DIR }).split('\n').filter((l) => !l.endsWith('/')).sort();
const expected = ['avalanche-markup/avalanche-markup.php', 'avalanche-markup/markup.js'];
if (JSON.stringify(listing) !== JSON.stringify(expected)) die(`zip listing unexpected:\n  ${listing.join('\n  ')}`);
const tmp = mkdtempSync(join(tmpdir(), 'avmk-'));
run('unzip', ['-q', 'avalanche-markup.zip', '-d', tmp], { cwd: PLUGIN_DIR });
if (!readFileSync(join(tmp, 'avalanche-markup', 'markup.js')).equals(readFileSync(DIST_JS))) die('bundle inside the zip differs from dist');
if (!readFileSync(join(tmp, 'avalanche-markup', 'avalanche-markup.php'), 'utf8').includes(`Version: ${version}`)) die('PHP inside the zip has the wrong version');
rmSync(tmp, { recursive: true, force: true });
const zipBuf = readFileSync(ZIP);
ok(`zip ${(zipBuf.length / 1024).toFixed(1)} KB — listing correct, bundle + version verified inside`);

if (dryRun) {
  step('Dry run complete — tree left modified, nothing committed or uploaded');
  console.log(run('git', ['status', '--short']));
  console.log('\nRestore with:  git checkout . && git clean -f wordpress-plugin/*.zip');
  process.exit(0);
}

// ---------------------------------------------------------------- 7. commit + tag
step('Commit + tag');
run('git', ['add', '-A', 'dist/markup.js', 'wordpress-plugin']);
run('git', ['commit', '-q', '-m', `Release v${version}`, '-m', changelog]);
run('git', ['tag', '-a', `v${version}`, '-m', `v${version}`]);
ok(`committed ${run('git', ['rev-parse', '--short', 'HEAD'])} and tagged v${version}`);

// ---------------------------------------------------------------- 8. upload
async function upload(key, buf, contentType, cacheControl) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${key}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': contentType,
      'Cache-Control': cacheControl,
      'x-upsert': 'true',
    },
    body: buf,
  });
  if (!r.ok) die(`upload ${key} failed: ${r.status} ${await r.text()}`);
  // Verify what the public URL now serves (cache-busted = origin).
  const v = await fetch(`${PUB}/${key}?v=${Date.now()}`);
  const body = Buffer.from(await v.arrayBuffer());
  const ct = v.headers.get('content-type') || '';
  if (v.status !== 200) die(`verify ${key}: HTTP ${v.status}`);
  if (!ct.startsWith(contentType)) die(`verify ${key}: content-type ${ct} (wanted ${contentType})`);
  if (sha256(body) !== sha256(buf)) die(`verify ${key}: served bytes differ from local`);
  ok(`${key}  (${contentType}, ${cacheControl}, sha256 ${sha256(buf).slice(0, 12)}…)`);
}

step('Upload to bucket (manifest last)');
const IMMUTABLE = 'public, max-age=31536000, immutable';
const SHORT = 'public, max-age=60';
await upload(zipKey, zipBuf, 'application/zip', IMMUTABLE);
await upload(`markup-${version}.js`, Buffer.from(js), 'application/javascript', IMMUTABLE);
await upload('markup.js', Buffer.from(js), 'application/javascript', SHORT);
{
  // The plain (uncached) URL is what browsers load; log what it serves now.
  const plain = await fetch(`${PUB}/markup.js`);
  const cc = plain.headers.get('cache-control');
  console.log(`   plain markup.js currently serves cache-control: ${cc}${cc && cc.includes('max-age=60') ? '' : '  (CDN may lag ≤60s)'}`);
}
await upload('plugin/avalanche-markup.zip', zipBuf, 'application/zip', SHORT);
await upload('plugin/update.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), 'application/json', SHORT);
{
  const m = await (await fetch(`${PUB}/plugin/update.json?v=${Date.now()}`)).json();
  if (m.version !== version) die(`published manifest version is ${m.version}`);
  const d = await fetch(m.download_url);
  if (d.status !== 200) die(`manifest download_url returned ${d.status}`);
  ok(`manifest live: version ${m.version}, download_url 200`);
}

// ---------------------------------------------------------------- 9. push
if (noPush) {
  step('--no-push: skipping git push (remember to push --follow-tags)');
} else {
  step('Push');
  run('git', ['push', 'origin', 'main', '--follow-tags'], { stdio: 'inherit' });
  ok('pushed main + tags');
}

// ---------------------------------------------------------------- summary
step(`Released v${version}`);
console.log(`  bundle    ${PUB}/markup.js`);
console.log(`  pinned    ${PUB}/markup-${version}.js`);
console.log(`  package   ${manifest.download_url}`);
console.log(`  manifest  ${PUB}/plugin/update.json`);
console.log(`  sha256    ${sha256(Buffer.from(js)).slice(0, 16)}… (bundle)  ${sha256(zipBuf).slice(0, 16)}… (zip)`);
console.log('\nSites do not auto-update: open Plugins on each site and click Update.');
console.log('The manifest cache refreshes within 1h, or immediately via Dashboard → Updates → Check again.');
