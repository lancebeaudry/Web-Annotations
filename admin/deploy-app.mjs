#!/usr/bin/env node
// Upload the built dashboard (dist/app/*) to the public `markup` bucket under
// app/, and optionally the overlay bundle (--bundle). Service-role key from
// .env; every object is verified after upload.
//
//   node admin/deploy-app.mjs            # dashboard
//   node admin/deploy-app.mjs --bundle   # also dist/markup.js -> markup.js

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, extname } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
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
const URL_ = env.SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) { console.error('.env needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
const PUB = `${URL_}/storage/v1/object/public/markup`;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain' };
const sha = (b) => createHash('sha256').update(b).digest('hex');

async function put(key, buf, type, cache = 'public, max-age=60') {
  const r = await fetch(`${URL_}/storage/v1/object/markup/${key}`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': type, 'Cache-Control': cache, 'x-upsert': 'true' },
    body: buf,
  });
  if (!r.ok) throw new Error(`upload ${key}: ${r.status} ${await r.text()}`);
  const v = await fetch(`${PUB}/${key}?v=${Date.now()}`);
  const body = Buffer.from(await v.arrayBuffer());
  const ct = v.headers.get('content-type') || '';
  const cd = v.headers.get('content-disposition') || '';
  if (v.status !== 200) throw new Error(`verify ${key}: ${v.status}`);
  if (!ct.startsWith(type.split(';')[0])) throw new Error(`verify ${key}: content-type ${ct}`);
  if (sha(body) !== sha(buf)) throw new Error(`verify ${key}: bytes differ`);
  if (/attachment/i.test(cd)) throw new Error(`verify ${key}: served as a download (${cd})`);
  console.log(`✔ ${key}  (${ct})`);
}

const dir = join(ROOT, 'dist', 'app');
if (!existsSync(dir)) { console.error('dist/app missing — run `node build-app.mjs` first'); process.exit(1); }
for (const f of readdirSync(dir)) {
  const type = TYPES[extname(f)] || 'application/octet-stream';
  await put(`app/${f}`, readFileSync(join(dir, f)), type);
}
if (process.argv.includes('--bundle')) {
  await put('markup.js', readFileSync(join(ROOT, 'dist', 'markup.js')), 'application/javascript');
}
console.log(`\nDashboard: ${PUB}/app/index.html`);
