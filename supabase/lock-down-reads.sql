-- Avalanche Markup — close project enumeration + scope comment reads
--
-- THE HOLE (verified live): the anon key is printed in every page that runs
-- the overlay. With it alone anyone could mint an anonymous session, then:
--   1. `select * from projects` -> every client name, token and site_url,
--      because the SELECT policy was a blanket `auth.role() = 'authenticated'`;
--   2. read every comment on any open_access project, because the comments
--      read policy trusted open_access alone.
-- Together: enumerate tokens, then read client feedback. A token is the key
-- to a project, so a listable token table is a listable key ring.
--
-- THE FIX
--   * Tokens are no longer discoverable. Direct SELECT on projects is now
--     team-or-member only; a token is resolved ONLY through
--     get_project_by_token(), which matches one exact token and cannot list.
--   * Reading an open project's comments now requires proving you knew its
--     token: get_project_by_token() records a row in project_unlocks, and the
--     comments read policy checks for it. Guessing a token is now the only
--     path in, instead of reading them all off a list.
--
-- NOTE ON SUBQUERIES: RLS applies to tables referenced inside another policy's
-- expression (that's why project_members carries its own "read own" policy).
-- So both comments policies, which subqueried `projects` for open_access,
-- would have broken the moment projects was tightened. They now call the
-- SECURITY DEFINER project_is_open() instead, decoupling them entirely.

-- 1. Proof that a user supplied the correct token for a project ------------
create table if not exists project_unlocks (
  user_id    uuid not null,
  project_id uuid not null references projects(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, project_id)
);
alter table project_unlocks enable row level security;

-- Callers may see only their OWN unlocks. Required so the subquery in the
-- comments read policy can see them (same pattern as project_members).
drop policy if exists "read own unlocks" on project_unlocks;
create policy "read own unlocks" on project_unlocks
  for select using (user_id = auth.uid());
-- No insert/update/delete policies: only the SECURITY DEFINER function writes.

-- 2. Is this project open? (SECURITY DEFINER so policies don't depend on
--    the caller's ability to read `projects`.)
create or replace function project_is_open(p_project uuid)
returns boolean language sql security definer stable
set search_path = public as $$
  select coalesce((select p.open_access from projects p where p.id = p_project), false);
$$;
revoke all on function project_is_open(uuid) from public, anon;
grant execute on function project_is_open(uuid) to authenticated;

-- 3. The ONLY way to resolve a token. Exact match, one row, never a list.
--    Returns the row for any signed-in caller so the overlay can still show
--    the accurate "you're not invited" card on a closed project, but records
--    an unlock (which is what grants comment reads) only for an open one.
create or replace function get_project_by_token(p_token text)
returns table (id uuid, name text, site_url text, open_access boolean)
language plpgsql security definer
set search_path = public as $$
declare
  v projects%rowtype;
  v_uid uuid := auth.uid();
begin
  if v_uid is null or p_token is null or length(p_token) = 0 then
    return;
  end if;

  select * into v from projects p where p.token = p_token;
  if not found then
    return;
  end if;

  if v.open_access then
    insert into project_unlocks (user_id, project_id)
    values (v_uid, v.id)
    on conflict do nothing;
  end if;

  id := v.id; name := v.name; site_url := v.site_url; open_access := v.open_access;
  return next;
end;
$$;
revoke all on function get_project_by_token(text) from public, anon;
grant execute on function get_project_by_token(text) to authenticated;

-- 4. projects: no more blanket listing -------------------------------------
drop policy if exists "read project by token" on projects;
create policy "read project by token" on projects
  for select using (
    (auth.jwt()->>'email') like '%@avalanchegr.com'
    or exists (
      select 1 from project_members pm
      where pm.project_id = projects.id
        and lower(pm.email) = lower(auth.jwt()->>'email')
    )
  );

-- 5. comments read: open_access alone is no longer enough — you must have
--    unlocked the project with its token.
drop policy if exists "read comments" on comments;
create policy "read comments" on comments
  for select using (
    (auth.jwt()->>'email') like '%@avalanchegr.com'
    or exists (
      select 1 from project_members pm
      where pm.project_id = comments.project_id
        and lower(pm.email) = lower(auth.jwt()->>'email')
    )
    or exists (
      select 1 from project_unlocks u
      where u.project_id = comments.project_id
        and u.user_id = auth.uid()
    )
  );

-- 6. comments insert: same rules as before, but via project_is_open() so the
--    policy no longer depends on reading `projects` directly.
drop policy if exists "insert comments" on comments;
create policy "insert comments" on comments
  for insert with check (
    (
      author_email = auth.jwt()->>'email'
      and (
        (auth.jwt()->>'email') like '%@avalanchegr.com'
        or exists (
          select 1 from project_members pm
          where pm.project_id = comments.project_id
            and lower(pm.email) = lower(auth.jwt()->>'email')
        )
      )
    )
    or (
      project_is_open(comments.project_id)
      and (
        (author_email = 'guest:' || auth.uid()::text and coalesce(author_name, '') <> '')
        or author_email = auth.jwt()->>'email'
      )
    )
  );
