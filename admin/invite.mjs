// Manage the invite list — who (outside the Avalanche team domain) may
// use the tool. Team emails (@avalanchegr.com) are always allowed and
// don't need to be added here.
//
//   node admin/invite.mjs add  someone@example.com ["optional note"]
//   node admin/invite.mjs remove someone@example.com
//   node admin/invite.mjs list
//
// Invited people can comment and reply, but never export (that stays
// team-only). Uses the service-role key — admin only, never shipped.
import { readFileSync, existsSync } from 'node:fs';

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
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const headers = {
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
};
const REST = `${SUPABASE_URL}/rest/v1/allowed_emails`;

const [cmd, rawEmail, note] = process.argv.slice(2);
const email = (rawEmail || '').trim().toLowerCase();

async function fail(label, res) {
  console.error(`${label} failed (HTTP ${res.status}): ${await res.text()}`);
  process.exit(1);
}

function validEmail(e) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
}

if (cmd === 'add') {
  if (!validEmail(email)) {
    console.error('Usage: node admin/invite.mjs add someone@example.com ["note"]');
    process.exit(1);
  }
  const res = await fetch(REST, {
    method: 'POST',
    headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ email, note: note || null }),
  });
  if (!res.ok) await fail('Invite', res);
  console.log(`Invited ${email} — they can comment after signing in (no export).`);
} else if (cmd === 'remove') {
  if (!validEmail(email)) {
    console.error('Usage: node admin/invite.mjs remove someone@example.com');
    process.exit(1);
  }
  const res = await fetch(`${REST}?email=eq.${encodeURIComponent(email)}`, {
    method: 'DELETE',
    headers,
  });
  if (!res.ok) await fail('Remove', res);
  console.log(`Removed ${email} from the invite list.`);
} else if (cmd === 'list') {
  const res = await fetch(`${REST}?select=email,note,created_at&order=created_at.asc`, { headers });
  if (!res.ok) await fail('List', res);
  const rows = await res.json();
  if (!rows.length) {
    console.log('No invited emails yet. (Anyone @avalanchegr.com is always allowed.)');
  } else {
    console.log(`Invited emails (${rows.length}):`);
    for (const r of rows) {
      console.log(`  ${r.email}${r.note ? `  — ${r.note}` : ''}`);
    }
  }
} else {
  console.error('Usage:\n  node admin/invite.mjs add someone@example.com ["note"]\n  node admin/invite.mjs remove someone@example.com\n  node admin/invite.mjs list');
  process.exit(1);
}
