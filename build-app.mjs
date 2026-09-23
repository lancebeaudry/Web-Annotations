// Build the customer dashboard (a static, hash-routed single-page app) into
// dist/app/. Mirrors build.mjs. Deployed to the public `markup` bucket under
// app/ by admin/deploy-app.mjs.
//
//   node build-app.mjs            -> dist/app/{index,terms,privacy}.html, app.js, app.css
//   node build-app.mjs --watch    -> rebuild on change + serve dist/app on :8124

import { build, context } from 'esbuild';
import { readFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const watch = process.argv.includes('--watch');

function loadEnv() {
  const env = {};
  if (existsSync('.env')) {
    for (const line of readFileSync('.env', 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return env;
}
const env = loadEnv();
const SUPABASE_URL = env.SUPABASE_URL || '';
const DASHBOARD_URL = env.DASHBOARD_URL || 'https://pinpoint.avalanchegr.com/app/';
const BUNDLE_URL = env.MARKUP_BUNDLE_URL || `${SUPABASE_URL}/storage/v1/object/public/markup/markup.js`;
let sha = 'dev';
try { sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* not in git / no spawn */ }
const APP_VERSION = process.env.MARKUP_VERSION || sha;

mkdirSync('dist/app', { recursive: true });
for (const f of readdirSync('dashboard/static')) {
  const from = `dashboard/static/${f}`;
  if (statSync(from).isDirectory()) {
    mkdirSync(`dist/app/${f}`, { recursive: true });
    for (const g of readdirSync(from)) copyFileSync(`${from}/${g}`, `dist/app/${f}/${g}`);
    continue;
  }
  if (!/\.(html|css|js|txt|json)$/.test(f)) { copyFileSync(from, `dist/app/${f}`); continue; }
  const src = readFileSync(from, 'utf8').replace(/__APP_VERSION__/g, APP_VERSION);
  writeFileSync(`dist/app/${f}`, src);
}

const options = {
  entryPoints: ['dashboard/src/main.js'],
  bundle: true,
  format: 'iife',
  target: ['es2019'],
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  outfile: 'dist/app/app.js',
  define: {
    __SUPABASE_URL__: JSON.stringify(SUPABASE_URL),
    __SUPABASE_ANON_KEY__: JSON.stringify(env.SUPABASE_ANON_KEY || ''),
    __FUNCTIONS_URL__: JSON.stringify(`${SUPABASE_URL}/functions/v1`),
    __BUNDLE_URL__: JSON.stringify(BUNDLE_URL),
    __DASHBOARD_URL__: JSON.stringify(DASHBOARD_URL),
    __PRO_PRICE_LABEL__: JSON.stringify(env.PRO_PRICE_LABEL || '$99 / year'),
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  logLevel: 'info',
};
const css = { entryPoints: ['dashboard/src/styles.css'], bundle: true, minify: !watch, outfile: 'dist/app/app.css', logLevel: 'info' };

if (watch) {
  const ctx = await context(options);
  const cctx = await context(css);
  await ctx.watch();
  await cctx.watch();
  const { port } = await ctx.serve({ servedir: 'dist/app', port: 8124 });
  console.log(`\nDashboard: http://localhost:${port}/index.html\n`);
} else {
  await build(options);
  await build(css);
}
