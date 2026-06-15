// Ship a tool update to every site by pinning the plugin to the current
// commit. Commit-pinned jsDelivr URLs are instant + immutable, so this
// sidesteps all @main caching/lag problems.
//
// Flow:
//   1. (you) commit + push the dist/markup.js change via GitHub Desktop
//   2. node admin/release.mjs
//        - stamps the current HEAD short-sha into the plugin's AVMK_REF
//        - copies the plugin into every local site that already has it
//        - refreshes ~/Desktop/avalanche-markup.zip
//        - verifies the commit-pinned markup.js is live on jsDelivr
//   3. reload any site — it serves the new build immediately
//
// Live (WP Engine) sites pick up the new ref on their next plugin
// re-upload from the refreshed zip.
import { readFileSync, writeFileSync, existsSync, cpSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PLUGIN_DIR = join(ROOT, 'wordpress-plugin', 'avalanche-markup');
const PLUGIN_PHP = join(PLUGIN_DIR, 'avalanche-markup.php');
const ZIP = join(homedir(), 'Desktop', 'avalanche-markup.zip');
const LOCAL_SITES = join(homedir(), 'Local Sites');

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', ...opts }).trim();
}

// 1. current commit
const sha = sh('git rev-parse --short HEAD', { cwd: ROOT });
const dirty = sh('git status --porcelain', { cwd: ROOT });
if (dirty) {
  console.warn('Warning: working tree has uncommitted changes. Commit + push dist/markup.js first so the pinned sha exists on GitHub.');
}

// 2. stamp AVMK_REF
let php = readFileSync(PLUGIN_PHP, 'utf8');
const before = php;
php = php.replace(/const AVMK_REF = '[^']*';/, `const AVMK_REF = '${sha}';`);
if (php === before && !php.includes(`const AVMK_REF = '${sha}'`)) {
  console.error('Could not find AVMK_REF line to update in the plugin.');
  process.exit(1);
}
writeFileSync(PLUGIN_PHP, php);
console.log(`Pinned plugin to commit ${sha}.`);

// 3. redeploy to every local site that already has the plugin
let copied = 0;
if (existsSync(LOCAL_SITES)) {
  for (const entry of sh(`ls "${LOCAL_SITES}"`).split('\n').filter(Boolean)) {
    const dest = join(LOCAL_SITES, entry, 'app/public/wp-content/plugins/avalanche-markup');
    if (existsSync(dest)) {
      cpSync(PLUGIN_DIR, dest, { recursive: true });
      console.log(`  updated: ${entry}`);
      copied++;
    }
  }
}
console.log(copied ? `Redeployed to ${copied} local site(s).` : 'No local installs found to update.');

// 4. refresh the shareable zip
rmSync(ZIP, { force: true });
sh(`cd "${join(ROOT, 'wordpress-plugin')}" && zip -qr "${ZIP}" avalanche-markup`);
console.log(`Refreshed ${ZIP}`);

// 5. verify the pinned build is live on jsDelivr
const url = `https://cdn.jsdelivr.net/gh/lancebeaudry/Web-Annotations@${sha}/dist/markup.js`;
try {
  const body = sh(`curl -s "${url}"`);
  console.log(body.length > 1000 ? `\nLive: ${url}\n(${body.length} bytes) — reload any site to see the update.` : `\nWarning: ${url} did not return the bundle yet. If you just pushed, give GitHub a few seconds and re-run.`);
} catch {
  console.log(`\nCould not reach jsDelivr to verify; check ${url} manually.`);
}

console.log('\nDon\'t forget to commit the plugin ref bump.');
