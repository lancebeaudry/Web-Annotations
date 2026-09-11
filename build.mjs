import { build, context } from 'esbuild';
import { readFileSync, existsSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const mock = process.argv.includes('--mock');

function loadEnv() {
  const env = {};
  if (existsSync('.env')) {
    for (const line of readFileSync('.env', 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith('#')) {
        env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  }
  return env;
}

const env = loadEnv();
if (!mock) {
  for (const key of ['SUPABASE_URL', 'SUPABASE_ANON_KEY']) {
    if (!env[key]) {
      console.warn(`[build] WARNING: ${key} is not set in .env — the bundle will no-op until you rebuild with it.`);
    }
  }
}

const options = {
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'iife',
  target: ['es2019'],
  minify: !watch && !mock,
  sourcemap: watch ? 'inline' : false,
  outfile: mock ? 'dist/markup.mock.js' : 'dist/markup.js',
  alias: mock ? { '@supabase/supabase-js': './test/mock-supabase.js' } : {},
  define: {
    __SUPABASE_URL__: JSON.stringify(mock ? 'mock://local' : env.SUPABASE_URL || ''),
    __SUPABASE_ANON_KEY__: JSON.stringify(mock ? 'mock-key' : env.SUPABASE_ANON_KEY || ''),
    // Where the overlay sends people to create an account / manage a project.
    __DASHBOARD_URL__: JSON.stringify(
      env.DASHBOARD_URL || 'https://lancebeaudry.github.io/avalanche-markup-app/'
    ),
    // Set by admin/release.mjs. The literal version string in the bundle is
    // what the release script verifies, so a stale build can never ship.
    __MARKUP_VERSION__: JSON.stringify(process.env.MARKUP_VERSION || 'dev'),
  },
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: '.', port: 8123 });
  console.log(`\nTest page: http://localhost:${port}/test/index.html?markup=test-token\n`);
} else {
  await build(options);
}
