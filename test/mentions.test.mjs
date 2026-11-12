// Run with `npm test`. The fake rpc answers the way list_mentionable does on
// the server (supabase/tenancy.sql): an anonymous session gets the raise that
// PostgREST returns as a 400, everyone else gets the project's roster.
import test from 'node:test';
import assert from 'node:assert/strict';
import { prefetchMentionables, mentionLabel } from '../src/ui/mentions.js';

function fakeApp({ isGuest }) {
  const calls = [];
  const supabase = {
    async rpc(name, args) {
      calls.push({ name, args });
      if (isGuest) return { data: null, error: { code: 'P0001', message: 'Not allowed' } };
      return { data: [{ email: 'owner@example.com', name: 'Olive Owner' }], error: null };
    },
  };
  return { app: { supabase, isGuest, project: { id: 'project-1' } }, calls };
}

const settled = () => new Promise((resolve) => setImmediate(resolve));

test('a guest session never asks for the roster', async () => {
  const { app, calls } = fakeApp({ isGuest: true });
  prefetchMentionables(app);
  await settled();
  assert.deepEqual(calls, []);
});

test('a signed-in session loads the roster once, for this project', async () => {
  const { app, calls } = fakeApp({ isGuest: false });
  prefetchMentionables(app);
  await settled();
  prefetchMentionables(app);
  await settled();
  assert.deepEqual(calls, [{ name: 'list_mentionable', args: { p_project: 'project-1' } }]);
  assert.equal(mentionLabel(app, 'owner@example.com'), 'Olive Owner');
});
