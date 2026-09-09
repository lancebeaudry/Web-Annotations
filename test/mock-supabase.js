// In-memory stand-in for @supabase/supabase-js, swapped in by
// `npm run build:mock` (esbuild alias). Lets the full overlay UI be
// exercised locally with no Supabase project.
//
// Pick the viewer's role with ?mockRole= (default: operator):
//   operator      Avalanche staff — sees everything, Invite/Export/Resolve
//   owner         owns the seeded project
//   collaborator  invited email (comment, no management)
//   guest         anonymous name-only visitor (project is treated as open)
//   none          signed in but no access -> "Access needed" card
// The seeded project has token 'test-token'; an UNSEEDED token exercises
// the auto-register path (owner/operator succeed; a free owner who already
// has one project hits PROJECT_LIMIT_REACHED via ?mockLimit=1).
export function createClient() {
  const params = new URLSearchParams(location.search);
  const role = params.get('mockRole') || 'operator';
  const atLimit = params.get('mockLimit') === '1';

  const USERS = {
    operator: { id: 'mock-operator', email: 'mock-team@avalanchegr.com' },
    owner: { id: 'mock-owner', email: 'owner@example.com' },
    collaborator: { id: 'mock-collab', email: 'guest@client.com' },
    guest: { id: 'mock-guest', email: null, is_anonymous: true },
    none: { id: 'mock-stranger', email: 'nobody@example.com' },
  };
  const user = USERS[role] || USERS.operator;
  const session = { user, access_token: 'mock' };

  const store = {
    projects: [
      { id: 'mock-project-1', token: 'test-token', name: 'Mock Project', site_url: 'http://localhost:8123', owner_id: 'mock-owner', open_access: role === 'guest' },
    ],
    comments: [],
    project_members: [{ project_id: 'mock-project-1', email: 'guest@client.com', note: 'demo client' }],
    operators: ['mock-operator'],
    secrets: { 'mock-project-1': 'mock-secret-0123456789abcdef' },
  };
  let nextId = 1;
  const ok = (data) => Promise.resolve({ data, error: null });
  const fail = (message) => Promise.resolve({ data: null, error: { message } });

  const isOperator = () => store.operators.includes(user.id);
  const roleOn = (pid) => {
    const p = store.projects.find((x) => x.id === pid);
    if (!p || !user) return 'none';
    if (isOperator()) return 'operator';
    if (p.owner_id === user.id) return 'owner';
    if (user.email && store.project_members.some((m) => m.project_id === pid && m.email === user.email)) return 'collaborator';
    if (p.open_access && (user.is_anonymous || role === 'guest')) return 'guest';
    return 'none';
  };
  const canManage = (pid) => ['operator', 'owner'].includes(roleOn(pid));

  function from(table) {
    const rows = store[table] || [];
    return {
      select() {
        return {
          eq(col, val) {
            const filtered = rows.filter((r) => r[col] === val);
            return {
              maybeSingle: () => ok(filtered[0] || null),
              single: () => ok(filtered[0] || null),
              order: () => ok(filtered.slice()),
            };
          },
          order: () => ok(rows.slice()),
          maybeSingle: () => ok(rows[0] || null),
        };
      },
      insert(row) {
        if (table === 'projects') {
          if (user.is_anonymous) return { select: () => ({ maybeSingle: () => fail('new row violates row-level security policy'), single: () => fail('rls') }) };
          if (atLimit && !isOperator()) return { select: () => ({ maybeSingle: () => fail('PROJECT_LIMIT_REACHED'), single: () => fail('PROJECT_LIMIT_REACHED') }) };
          row = { id: `mock-p${nextId++}`, created_at: new Date().toISOString(), open_access: false, owner_id: user.id, ...row };
          store.secrets[row.id] = `mock-secret-${row.id}`;
        } else {
          row = { id: `mock-c${nextId++}`, created_at: new Date().toISOString(), status: 'open', parent_id: null, author_name: null, author_role: roleOn(row.project_id), ...row };
        }
        rows.push(row);
        return { select: () => ({ single: () => ok(row), maybeSingle: () => ok(row) }) };
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
      signInWithOtp: () => ok({}),
      signInAnonymously: () => ok({ session }),
      verifyOtp: () => ok({ session }),
      signOut: () => Promise.resolve({ error: null }),
    },
    storage: {
      from: () => ({
        upload: () => ok({}),
        getPublicUrl: (path) => ({ data: { publicUrl: `mock://comment-media/${path}` } }),
        remove: () => ok([]),
      }),
    },
    rpc(name, args = {}) {
      const pid = args.p_project;
      switch (name) {
        case 'get_project_by_token': {
          const p = store.projects.find((x) => x.token === args.p_token);
          const r = ok(p ? [{ id: p.id, name: p.name, site_url: p.site_url, open_access: p.open_access }] : []);
          r.maybeSingle = () => ok(p ? { id: p.id, name: p.name, site_url: p.site_url, open_access: p.open_access } : null);
          return r;
        }
        case 'my_project_role': return ok({ role: roleOn(pid), writable: roleOn(pid) !== 'none' && !(atLimit && roleOn(pid) === 'owner' && pid !== 'mock-project-1') });
        case 'my_account': return ok({ signed_in: true, is_operator: isOperator(), plan: 'free', status: 'none', project_limit: isOperator() ? 2147483647 : 1, owned_count: store.projects.filter((p) => p.owner_id === user.id).length });
        case 'is_member': return ok(roleOn(pid) === 'collaborator');
        case 'get_bridge_secret': return canManage(pid) ? ok(store.secrets[pid]) : fail('Only the project owner can view the site secret');
        case 'rotate_bridge_secret': if (!canManage(pid)) return fail('Only the project owner can rotate the site secret'); store.secrets[pid] = `mock-secret-${Date.now()}`; return ok(store.secrets[pid]);
        case 'invite_email': {
          if (!canManage(pid)) return fail('Only the project owner can manage access');
          const email = (args.p_email || '').trim().toLowerCase();
          const row = store.project_members.find((r) => r.project_id === pid && r.email === email);
          if (row) row.note = args.p_note || null;
          else store.project_members.push({ project_id: pid, email, note: args.p_note || null, created_at: new Date().toISOString() });
          return ok(email);
        }
        case 'list_invites': return canManage(pid) ? ok(store.project_members.filter((r) => r.project_id === pid)) : fail('Only the project owner can view access');
        case 'revoke_invite': {
          if (!canManage(pid)) return fail('Only the project owner can manage access');
          const email = (args.p_email || '').trim().toLowerCase();
          const i = store.project_members.findIndex((r) => r.project_id === pid && r.email === email);
          if (i >= 0) store.project_members.splice(i, 1);
          return ok(email);
        }
        case 'list_mentionable': {
          if (roleOn(pid) === 'none' || user.is_anonymous) return fail('Not allowed');
          const people = new Map();
          for (const c of store.comments) if (c.project_id === pid && !String(c.author_email).startsWith('guest:')) people.set(c.author_email, c.author_name);
          people.set('owner@example.com', null);
          people.delete(user.email);
          return ok([...people].map(([email, name]) => ({ email, name })));
        }
        default: return fail(`unknown rpc ${name}`);
      }
    },
    from,
    channel() {
      const ch = { on: () => ch, subscribe: () => ch };
      return ch;
    },
  };
}
