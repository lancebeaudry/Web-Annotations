-- Avalanche Markup — guest ("open") access
--
-- Lets anyone who opens a staging link comment after typing only a display
-- name: no WordPress account, no email, no code. Guests sign in with a
-- Supabase ANONYMOUS session, so they carry a real JWT (role=authenticated,
-- is_anonymous=true, no email) and the existing RLS/realtime/Storage model
-- keeps working instead of exposing the tables to unauthenticated writes.
--
-- Guest identity: anonymous users have no email, but comments.author_email
-- is NOT NULL and every own-row policy keys off it. So a guest stores the
-- synthetic id 'guest:' || auth.uid(). It satisfies NOT NULL, can never
-- match the team-domain check, and gives own-row policies a stable key.
-- Guests always supply a display name, so this value stays out of the UI.

-- 1. Per-project toggle (driven by the WordPress plugin setting) ---------
alter table projects add column if not exists open_access boolean not null default false;

-- 2. Comment policies: add a guest branch alongside team / project_members
-- "Open" = this comment's project has open_access on.

drop policy if exists "read comments" on comments;
create policy "read comments" on comments
  for select using (
    (auth.jwt()->>'email') like '%@avalanchegr.com'
    or exists (
      select 1 from project_members pm
      where pm.project_id = comments.project_id
        and lower(pm.email) = lower(auth.jwt()->>'email')
    )
    -- Guests on an open project see the whole conversation, so they can
    -- read replies to their own feedback.
    or exists (
      select 1 from projects p
      where p.id = comments.project_id and p.open_access
    )
  );

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
    -- Open-project branch. On a project with open_access, any authenticated
    -- visitor may comment — but only pinned to their OWN identity, never
    -- someone else's:
    --   * a name-only guest as their synthetic 'guest:'||uid (name required,
    --     since the name is their only attribution); or
    --   * a real signed-in visitor (e.g. a client who once used an email
    --     code, or anyone with a Supabase session) as their own JWT email.
    -- Pinning author_email to either auth.uid() or the caller's own JWT email
    -- is what stops anyone posting under a team or someone else's address.
    or (
      exists (select 1 from projects p where p.id = comments.project_id and p.open_access)
      and (
        (author_email = 'guest:' || auth.uid()::text and coalesce(author_name, '') <> '')
        or author_email = auth.jwt()->>'email'
      )
    )
  );

drop policy if exists "update own or team" on comments;
create policy "update own or team" on comments
  for update using (
    author_email = auth.jwt()->>'email'
    or (auth.jwt()->>'email') like '%@avalanchegr.com'
    or author_email = 'guest:' || auth.uid()::text
  );

drop policy if exists "delete own or team" on comments;
create policy "delete own or team" on comments
  for delete using (
    author_email = auth.jwt()->>'email'
    or (auth.jwt()->>'email') like '%@avalanchegr.com'
    or author_email = 'guest:' || auth.uid()::text
  );

-- Note: the projects SELECT policy (auth.role() = 'authenticated') already
-- covers guests — anonymous users carry the authenticated role — and the
-- comment-media Storage policy ("for insert to authenticated") likewise, so
-- guest image attachments work with no further change.
