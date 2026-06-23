-- Avalanche Markup — project-scoped access (replaces the global allow-list)
-- Run after schema.sql + notifications.sql. Idempotent where practical.
--
-- Before: anyone in allowed_emails could read EVERY project's comments.
-- After: access is per project via project_members. Team (@avalanchegr.com)
-- still sees everything; everyone else only sees projects they belong to.

-- 1. Membership table -------------------------------------------------
create table if not exists project_members (
  project_id uuid not null references projects(id) on delete cascade,
  email      text not null,
  note       text,
  created_at timestamptz default now(),
  primary key (project_id, email)
);
alter table project_members enable row level security;

-- A signed-in user may read their OWN membership rows (the overlay's
-- access gate checks "am I a member of this project?"). No broad list.
drop policy if exists "read own membership" on project_members;
create policy "read own membership" on project_members
  for select using (lower(email) = lower(auth.jwt()->>'email'));

-- 2. Migrate existing access -----------------------------------------
-- The only non-team invitees are the @gordonwater.com reviewers, who all
-- belong to the Gordon Water Systems project. Team emails need no rows.
insert into project_members (project_id, email, note)
select p.id, lower(ae.email), 'migrated from allow-list'
  from allowed_emails ae
  cross join lateral (select id from projects where token = 'gordon-water-ba00dbf5') p
 where lower(ae.email) like '%@gordonwater.com'
on conflict (project_id, email) do nothing;

-- 3. Project-scoped comment policies ---------------------------------
-- Shared predicate: caller is team, or a member of the row's project.
drop policy if exists "read comments" on comments;
create policy "read comments" on comments
  for select using (
    (auth.jwt()->>'email') like '%@avalanchegr.com'
    or exists (
      select 1 from project_members pm
      where pm.project_id = comments.project_id
        and lower(pm.email) = lower(auth.jwt()->>'email')
    )
  );

drop policy if exists "insert comments" on comments;
create policy "insert comments" on comments
  for insert with check (
    author_email = auth.jwt()->>'email'
    and (
      (auth.jwt()->>'email') like '%@avalanchegr.com'
      or exists (
        select 1 from project_members pm
        where pm.project_id = comments.project_id
          and lower(pm.email) = lower(auth.jwt()->>'email')
      )
    )
  );
-- update/delete policies ("own row or team") are unchanged.

-- 4. Project-scoped invite management (team-gated, SECURITY DEFINER) --
-- Replaces the global invite_email/list_invites/revoke_invite.
drop function if exists public.invite_email(text, text);
create or replace function public.invite_email(p_project uuid, p_email text, p_note text default null)
returns text language plpgsql security definer set search_path = public as $fn$
declare caller text := lower(coalesce(auth.jwt()->>'email',''));
begin
  if caller not like '%@avalanchegr.com' then
    raise exception 'Only Avalanche team members can invite';
  end if;
  if p_email is null or position('@' in p_email) = 0 then
    raise exception 'Enter a valid email address';
  end if;
  insert into project_members (project_id, email, note)
  values (p_project, lower(trim(p_email)), nullif(trim(p_note),''))
  on conflict (project_id, email) do update set note = excluded.note;
  return lower(trim(p_email));
end; $fn$;
revoke all on function public.invite_email(uuid, text, text) from public, anon;
grant execute on function public.invite_email(uuid, text, text) to authenticated;

drop function if exists public.list_invites();
create or replace function public.list_invites(p_project uuid)
returns setof project_members language plpgsql security definer set search_path = public as $fn$
begin
  if lower(coalesce(auth.jwt()->>'email','')) not like '%@avalanchegr.com' then
    raise exception 'Only Avalanche team members can view invites';
  end if;
  return query select * from project_members where project_id = p_project order by created_at asc;
end; $fn$;
revoke all on function public.list_invites(uuid) from public, anon;
grant execute on function public.list_invites(uuid) to authenticated;

drop function if exists public.revoke_invite(text);
create or replace function public.revoke_invite(p_project uuid, p_email text)
returns text language plpgsql security definer set search_path = public as $fn$
begin
  if lower(coalesce(auth.jwt()->>'email','')) not like '%@avalanchegr.com' then
    raise exception 'Only Avalanche team members can remove invites';
  end if;
  delete from project_members where project_id = p_project and email = lower(trim(p_email));
  return lower(trim(p_email));
end; $fn$;
revoke all on function public.revoke_invite(uuid, text) from public, anon;
grant execute on function public.revoke_invite(uuid, text) to authenticated;

-- 5. is_member helper for the overlay's access gate ------------------
create or replace function public.is_member(p_project uuid)
returns boolean language sql security definer set search_path = public as $fn$
  select exists (
    select 1 from project_members pm
    where pm.project_id = p_project
      and lower(pm.email) = lower(auth.jwt()->>'email')
  );
$fn$;
revoke all on function public.is_member(uuid) from public, anon;
grant execute on function public.is_member(uuid) to authenticated;
