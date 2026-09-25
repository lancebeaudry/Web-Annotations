// Build the Chrome extension into dist/extension (load unpacked from there).
//   node build-ext.mjs
// Reads SUPABASE_URL / SUPABASE_ANON_KEY from .env like build.mjs.
import { build } from 'esbuild';
import { readFileSync, mkdirSync, copyFileSync, readdirSync, existsSync } from 'node:fs';

function loadEnv() {
  const env = { ...process.env };
  if (existsSync('.env')) {
    for (const line of readFileSync('.env', 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in env)) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return env;
}
const env = loadEnv();
for (const k of ['SUPABASE_URL', 'SUPABASE_ANON_KEY']) if (!env[k]) throw new Error(`${k} missing from .env`);

const out = 'dist/extension';
mkdirSync(`${out}/icons`, { recursive: true });
const define = { __SUPABASE_URL__: JSON.stringify(env.SUPABASE_URL), __SUPABASE_ANON_KEY__: JSON.stringify(env.SUPABASE_ANON_KEY) };
for (const [entry, file] of [['extension/src/background.js', 'background.js'], ['extension/src/picker.js', 'picker.js'], ['extension/src/popup.js', 'popup.js']]) {
  await build({ entryPoints: [entry], bundle: true, minify: false, format: 'iife', target: ['chrome120'], outfile: `${out}/${file}`, define, logLevel: 'error' });
}
copyFileSync('extension/manifest.json', `${out}/manifest.json`);
copyFileSync('extension/popup.html', `${out}/popup.html`);
for (const f of readdirSync('extension/icons')) copyFileSync(`extension/icons/${f}`, `${out}/icons/${f}`);
console.log(`extension → ${out}`);
