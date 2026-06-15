// In-memory stand-in for @supabase/supabase-js, swapped in by
// `npm run build:mock` (esbuild alias). Lets the full overlay UI be
// exercised locally with no Supabase project: pre-authed team session,
// seeded project row, comments held in memory.
export function createClient() {
  const store = {
    projects: [
      { id: 'mock-project-1', token: 'test-token', name: 'Mock Project', site_url: 'http://localhost:8123' },
    ],
    comments: [],
    // Invite list for testing the access gate. guest@client.com is
    // invited (non-team); anyone else non-team is blocked.
    allowed_emails: [{ email: 'guest@client.com', note: 'demo client' }],
  };
  let nextId = 1;
  // Override the signed-in email with ?mockEmail= to test roles:
  //   (default) mock-team@avalanchegr.com → team (full powers)
  //   guest@client.com                    → invited (comment, no export)
  //   anyone-else@x.com                   → blocked
  const mockEmail =
    new URLSearchParams(location.search).get('mockEmail') || 'mock-team@avalanchegr.com';
  const session = { user: { email: mockEmail }, access_token: 'mock' };

  const ok = (data) => Promise.resolve({ data, error: null });

  function from(table) {
    const rows = store[table] || [];
    return {
      select() {
        return {
          eq(col, val) {
            const filtered = rows.filter((r) => r[col] === val);
            return {
              maybeSingle: () => ok(filtered[0] || null),
              order: () => ok(filtered.slice()),
            };
          },
        };
      },
      insert(row) {
        const full = {
          id: `mock-c${nextId++}`,
          created_at: new Date().toISOString(),
          status: 'open',
          parent_id: null,
          author_name: null,
          ...row,
        };
        rows.push(full);
        return { select: () => ({ single: () => ok(full) }) };
      },
      update(patch) {
        return {
          eq(col, val) {
            const row = rows.find((r) => r[col] === val);
            if (row) Object.assign(row, patch);
            return { select: () => ({ single: () => ok(row || null) }) };
          },
        };
      },
      delete() {
        return {
          eq(col, val) {
            for (let i = rows.length - 1; i >= 0; i--) {
              if (rows[i][col] === val || rows[i].parent_id === val) rows.splice(i, 1);
            }
            return ok(null);
          },
        };
      },
    };
  }

  return {
    auth: {
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      getSession: () => Promise.resolve({ data: { session } }),
      signInWithOtp: () => Promise.resolve({ data: {}, error: null }),
      signOut: () => Promise.resolve({ error: null }),
    },
    from,
    channel() {
      const ch = { on: () => ch, subscribe: () => ch };
      return ch;
    },
  };
}
