-- Avalanche Markup 2.0 — ownership, operators, plans, per-project secrets,
-- storage hardening. Run AFTER lock-down-reads.sql and team-create-projects.sql.
-- Idempotent where Postgres allows it; safe to re-run.
--
-- WHY: until now the only notion of "who is allowed" was a hardcoded email
-- domain (@avalanchegr.com) written into policies and functions. A hosted
-- product needs: customers who OWN projects, a revocable OPERATOR role for
-- staff (support/moderation, disclosed in the privacy policy), plan limits
-- enforced in the DATABASE (the anon key is public, so a JS-only cap is
-- bypassable), per-project bridge secrets instead of one global secret, and
-- storage uploads scoped to the project a caller may write to.
--
-- MODEL
--   projects.owner_id      the paying/billing subject (one per project)
--   project_members        collaborators, invited by EMAIL (they may not have
--                          an account yet) — unchanged table
--   operators              Avalanche staff; data, not a domain rule
--   plans / subscriptions  plan limits; `subscriptions` is written ONLY by the
--                          Stripe webhook (absent row = free)
--   project_secrets        bridge secret per project; separate table so
--                          collaborators (who can SELECT projects) never see it
--   comments.author_role   stamped server-side at insert; historically
--                          accurate labels with no joins at render time
--
-- LIMITS
--   projects BEFORE INSERT trigger: owner := auth.uid() for JWT callers,
--   per-owner advisory lock, raise PROJECT_LIMIT_REACHED when at the limit.
--   Downgrade: project_is_writable() keeps the owner's OLDEST N projects live
--   (N = effective limit) and freezes the rest read-only. Self-healing: paying
--   again unfreezes instantly. Nothing is ever deleted.
--
-- RLS NOTE: RLS applies to tables referenced inside another policy's
-- expression, so every predicate below goes through SECURITY DEFINER helpers
-- rather than subquerying protected tables directly.

-- ============================================================ 1. plans + subscriptions
create table if not exists plans (
  id                     text primary key,
  project_limit          integer not null,
  attachment_bytes_limit bigint  not null,
  created_at             timestamptz not null default now()
);
insert into plans (id, project_limit, attachment_bytes_limit) values
  ('free', 1,  104857600),     -- 1 project, 100 MB of images per project
  ('pro',  10, 5368709120)     -- 10 projects, 5 GB per project
on conflict (id) do update set project_limit = excluded.project_limit,
                               attachment_bytes_limit = excluded.attachment_bytes_limit;
alter table plans enable row level security;
drop policy if exists "plans are public" on plans;
create policy "plans are public" on plans for select using (true);

-- Written only by the stripe-webhook edge function (service role).
create table if not exists subscriptions (
  user_id                uuid primary key references auth.users(id) on delete cascade,
  plan                   text not null default 'free' references plans(id),
  status                 text not null default 'none',   -- raw Stripe status, or 'none'
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  grace_until            timestamptz,                    -- past_due grace deadline
  stripe_customer_id     text unique,
  stripe_subscription_id text unique,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
alter table subscriptions enable row level security;
drop policy if exists "read own subscription" on subscriptions;
create policy "read own subscription" on subscriptions for select using (user_id = auth.uid());
-- no insert/update/delete policies: service role only.

-- Webhook idempotency ledger (service role only).
create table if not exists billing_events (
  id          text primary key,
  type        text not null,
  received_at timestamptz not null default now()
);
alter table billing_events enable row level security;

-- ============================================================ 2. operators
create table if not exists operators (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  note       text,
  added_by   uuid,
  created_at timestamptz not null default now()
);
alter table operators enable row level security;   -- zero policies: helpers only

-- ============================================================ 3. ownership, roles, secrets
alter table projects add column if not exists owner_id uuid references auth.users(id);
create index if not exists projects_owner_idx on projects (owner_id, created_at);

alter table comments add column if not exists author_role text
  check (author_role in ('operator','owner','collaborator','guest'));

create table if not exists project_secrets (
  project_id    uuid primary key references projects(id) on delete cascade,
  bridge_secret text not null,
  created_at    timestamptz not null default now(),
  rotated_at    timestamptz
);
alter table project_secrets enable row level security;   -- zero policies

create table if not exists attachment_tombstones (
  path       text primary key,
  created_at timestamptz not null default now()
);
alter table attachment_tombstones enable row level security;   -- service role only

-- ============================================================ 4. helpers (SECURITY DEFINER)
create or replace function is_anonymous_session() returns boolean
language sql stable as $$
  select coalesce((auth.jwt()->>'is_anonymous')::boolean, false);
$$;

create or replace function is_operator() returns boolean
language sql security definer stable set search_path = public as $$
  select auth.uid() is not null
     and exists (select 1 from operators o where o.user_id = auth.uid());
$$;

create or replace function is_project_owner(p_project uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select auth.uid() is not null
     and exists (select 1 from projects p where p.id = p_project and p.owner_id = auth.uid());
$$;

create or replace function is_project_collaborator(p_project uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select coalesce(auth.jwt()->>'email','') <> ''
     and exists (select 1 from project_members pm
                  where pm.project_id = p_project
                    and lower(pm.email) = lower(auth.jwt()->>'email'));
$$;

create or replace function has_unlock(p_project uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select auth.uid() is not null
     and exists (select 1 from project_unlocks u
                  where u.project_id = p_project and u.user_id = auth.uid());
$$;

-- People who may write regardless of open_access.
create or replace function can_write_project(p_project uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select is_operator() or is_project_owner(p_project) or is_project_collaborator(p_project);
$$;

-- People who may read: writers, plus token-unlocked visitors of an open project.
create or replace function can_read_project(p_project uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select can_write_project(p_project)
      or (project_is_open(p_project) and has_unlock(p_project));
$$;

-- Pro counts while active/trialing, or past_due inside the grace window, and
-- the period has not ended. Anything else (or no row) is free. Operators are
-- unlimited.
create or replace function effective_project_limit(p_user uuid) returns integer
language sql security definer stable set search_path = public as $$
  select case
    when exists (select 1 from operators o where o.user_id = p_user) then 2147483647
    else coalesce((
      select pl.project_limit
        from subscriptions s join plans pl on pl.id = s.plan
       where s.user_id = p_user
         and s.plan <> 'free'
         and (s.status in ('active','trialing')
              or (s.status = 'past_due' and coalesce(s.grace_until, 'infinity'::timestamptz) > now()))
         and (s.current_period_end is null or s.current_period_end > now()
              or (s.status = 'past_due' and coalesce(s.grace_until, 'infinity'::timestamptz) > now()))
    ), (select project_limit from plans where id = 'free'))
  end;
$$;

create or replace function owned_project_count(p_user uuid) returns integer
language sql security definer stable set search_path = public as $$
  select count(*)::int from projects where owner_id = p_user;
$$;

-- "Oldest N stay live": writable iff the owner is an operator, or this project
-- ranks within the owner's effective limit ordered by creation.
create or replace function project_is_writable(p_project uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select coalesce((
    select exists (select 1 from operators o where o.user_id = p.owner_id)
        or (select r.rn from (
              select x.id, row_number() over (order by x.created_at, x.id) as rn
                from projects x where x.owner_id = p.owner_id) r
             where r.id = p_project) <= effective_project_limit(p.owner_id)
      from projects p where p.id = p_project
  ), false);
$$;

-- One call for the client: role + whether the project accepts writes.
create or replace function my_project_role(p_project uuid) returns jsonb
language plpgsql security definer stable set search_path = public as $$
declare r text;
begin
  if auth.uid() is null then
    return jsonb_build_object('role', 'none', 'writable', false);
  end if;
  if is_operator() then r := 'operator';
  elsif is_project_owner(p_project) then r := 'owner';
  elsif is_project_collaborator(p_project) then r := 'collaborator';
  elsif project_is_open(p_project) and (is_anonymous_session() or has_unlock(p_project)) then r := 'guest';
  else r := 'none';
  end if;
  return jsonb_build_object('role', r, 'writable', r <> 'none' and project_is_writable(p_project));
end $$;

create or replace function my_account() returns jsonb
language plpgsql security definer stable set search_path = public as $$
declare v_plan text; v_status text; v_end timestamptz; v_cancel boolean;
begin
  if auth.uid() is null then return jsonb_build_object('signed_in', false); end if;
  select s.plan, s.status, s.current_period_end, s.cancel_at_period_end
    into v_plan, v_status, v_end, v_cancel from subscriptions s where s.user_id = auth.uid();
  return jsonb_build_object(
    'signed_in', true,
    'is_operator', is_operator(),
    'plan', coalesce(v_plan, 'free'),
    'status', coalesce(v_status, 'none'),
    'current_period_end', v_end,
    'cancel_at_period_end', coalesce(v_cancel, false),
    'project_limit', effective_project_limit(auth.uid()),
    'owned_count', owned_project_count(auth.uid())
  );
end $$;

create or replace function get_bridge_secret(p_project uuid) returns text
language plpgsql security definer set search_path = public as $$
begin
  if not (is_operator() or is_project_owner(p_project)) then
    raise exception 'Only the project owner can view the site secret';
  end if;
  return (select bridge_secret from project_secrets where project_id = p_project);
end $$;

create or replace function rotate_bridge_secret(p_project uuid) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare v text;
begin
  if not (is_operator() or is_project_owner(p_project)) then
    raise exception 'Only the project owner can rotate the site secret';
  end if;
  v := encode(extensions.gen_random_bytes(24), 'hex');
  insert into project_secrets (project_id, bridge_secret, rotated_at)
  values (p_project, v, now())
  on conflict (project_id) do update set bridge_secret = excluded.bridge_secret, rotated_at = now();
  return v;
end $$;

create or replace function add_operator(p_email text) returns void
language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  if not is_operator() then raise exception 'Only operators can add operators'; end if;
  select id into v from auth.users where lower(email) = lower(trim(p_email));
  if v is null then raise exception 'No account with that email has signed in yet'; end if;
  insert into operators (user_id, note, added_by) values (v, 'added via add_operator', auth.uid())
  on conflict do nothing;
end $$;

create or replace function remove_operator(p_email text) returns void
language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  if not is_operator() then raise exception 'Only operators can remove operators'; end if;
  select id into v from auth.users where lower(email) = lower(trim(p_email));
  if v = auth.uid() then raise exception 'You cannot remove yourself'; end if;
  delete from operators where user_id = v;
end $$;

-- Compatibility: 1.9.x bundles call is_member(uuid).
create or replace function is_member(p_project uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select is_project_collaborator(p_project);
$$;

do $$ begin
  execute 'revoke all on function is_anonymous_session(), is_operator(), is_project_owner(uuid), is_project_collaborator(uuid), has_unlock(uuid), can_write_project(uuid), can_read_project(uuid), effective_project_limit(uuid), owned_project_count(uuid), project_is_writable(uuid), my_project_role(uuid), my_account(), get_bridge_secret(uuid), rotate_bridge_secret(uuid), add_operator(text), remove_operator(text), is_member(uuid) from public, anon';
  execute 'grant execute on function is_anonymous_session(), is_operator(), is_project_owner(uuid), is_project_collaborator(uuid), has_unlock(uuid), can_write_project(uuid), can_read_project(uuid), effective_project_limit(uuid), owned_project_count(uuid), project_is_writable(uuid), my_project_role(uuid), my_account(), get_bridge_secret(uuid), rotate_bridge_secret(uuid), add_operator(text), remove_operator(text), is_member(uuid) to authenticated';
end $$;

-- ============================================================ 5. triggers
-- projects: owner = caller, plan limit under a per-owner lock.
create or replace function projects_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null then new.owner_id := auth.uid(); end if;   -- JWT callers can't pick an owner
  if new.owner_id is null then raise exception 'owner_id required'; end if;
  perform pg_advisory_xact_lock(hashtext(new.owner_id::text));
  if owned_project_count(new.owner_id) >= effective_project_limit(new.owner_id) then
    raise exception 'PROJECT_LIMIT_REACHED' using errcode = 'check_violation',
      hint = 'Upgrade your plan to add more projects.';
  end if;
  return new;
end $$;
drop trigger if exists projects_before_insert on projects;
create trigger projects_before_insert before insert on projects
  for each row execute function projects_before_insert();

-- projects: mint the bridge secret.
create or replace function projects_after_insert_secret() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  insert into project_secrets (project_id, bridge_secret)
  values (new.id, encode(extensions.gen_random_bytes(24), 'hex'))
  on conflict do nothing;
  return new;
end $$;
drop trigger if exists projects_after_insert_secret on projects;
create trigger projects_after_insert_secret after insert on projects
  for each row execute function projects_after_insert_secret();

-- comments: stamp the role server-side; guard immutable columns on update.
create or replace function comments_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then
      new.author_role := (my_project_role(new.project_id)->>'role');
      if new.author_role = 'none' then new.author_role := 'guest'; end if;
    end if;
  elsif tg_op = 'UPDATE' and auth.uid() is not null then
    if new.project_id <> old.project_id or new.author_email <> old.author_email
       or new.author_role is distinct from old.author_role
       or new.parent_id is distinct from old.parent_id then
      raise exception 'immutable column';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists comments_before_write on comments;
create trigger comments_before_write before insert or update on comments
  for each row execute function comments_before_write();

-- comments: tombstone attachments so the sweeper removes the objects.
create or replace function comments_after_delete_tombstone() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into attachment_tombstones (path)
  select substring(a->>'url' from '/comment-media/(.*)$')
    from jsonb_array_elements(coalesce(old.attachments, '[]'::jsonb)) a
   where a->>'url' like '%/comment-media/%'
  on conflict do nothing;
  return old;
end $$;
drop trigger if exists comments_after_delete_tombstone on comments;
create trigger comments_after_delete_tombstone after delete on comments
  for each row execute function comments_after_delete_tombstone();

-- ============================================================ 6. policies
-- projects
drop policy if exists "read project by token" on projects;
create policy "read project by token" on projects for select using (
  is_operator() or owner_id = auth.uid() or is_project_collaborator(projects.id)
);
drop policy if exists "team creates projects" on projects;
drop policy if exists "owner creates projects" on projects;
create policy "owner creates projects" on projects for insert with check (
  auth.uid() is not null and not is_anonymous_session() and owner_id = auth.uid()
);
drop policy if exists "owner updates project" on projects;
create policy "owner updates project" on projects for update
  using (is_operator() or owner_id = auth.uid())
  with check (is_operator() or owner_id = auth.uid());
drop policy if exists "owner deletes project" on projects;
create policy "owner deletes project" on projects for delete
  using (is_operator() or owner_id = auth.uid());

-- comments
drop policy if exists "read comments" on comments;
create policy "read comments" on comments for select using (can_read_project(comments.project_id));

drop policy if exists "insert comments" on comments;
create policy "insert comments" on comments for insert with check (
  project_is_writable(comments.project_id) and (
    (author_email = auth.jwt()->>'email' and can_write_project(comments.project_id))
    or (project_is_open(comments.project_id) and (
          (author_email = 'guest:' || auth.uid()::text and coalesce(author_name, '') <> '')
          or author_email = auth.jwt()->>'email'))
  )
);

drop policy if exists "update own or team" on comments;
drop policy if exists "update own or manager" on comments;
create policy "update own or manager" on comments for update using (
  project_is_writable(comments.project_id) and (
    is_operator() or is_project_owner(comments.project_id)
    or author_email = auth.jwt()->>'email'
    or author_email = 'guest:' || auth.uid()::text)
);
drop policy if exists "delete own or team" on comments;
drop policy if exists "delete own or manager" on comments;
create policy "delete own or manager" on comments for delete using (
  is_operator() or is_project_owner(comments.project_id)
  or author_email = auth.jwt()->>'email'
  or author_email = 'guest:' || auth.uid()::text
);

-- ============================================================ 7. function gates
-- Postgres can't change a function's return type via CREATE OR REPLACE, so
-- drop the pre-2.0 definitions first (same signatures are recreated below).
drop function if exists invite_email(uuid, text, text);
drop function if exists list_invites(uuid);
drop function if exists revoke_invite(uuid, text);
drop function if exists list_mentionable(uuid);

create or replace function invite_email(p_project uuid, p_email text, p_note text default null)
returns text language plpgsql security definer set search_path = public as $$
declare e text := lower(trim(p_email));
begin
  if not (is_operator() or is_project_owner(p_project)) then
    raise exception 'Only the project owner can manage access';
  end if;
  if e = '' or e not like '%@%' or e like 'guest:%' then raise exception 'Invalid email'; end if;
  if exists (select 1 from operators o join auth.users u on u.id = o.user_id where lower(u.email) = e) then
    return e;  -- operators already have access
  end if;
  insert into project_members (project_id, email, note) values (p_project, e, p_note)
  on conflict (project_id, email) do update set note = excluded.note;
  return e;
end $$;

create or replace function list_invites(p_project uuid)
returns setof project_members language plpgsql security definer set search_path = public as $$
begin
  if not (is_operator() or is_project_owner(p_project)) then
    raise exception 'Only the project owner can view access';
  end if;
  return query select * from project_members where project_id = p_project order by created_at;
end $$;

create or replace function revoke_invite(p_project uuid, p_email text)
returns text language plpgsql security definer set search_path = public as $$
declare e text := lower(trim(p_email));
begin
  if not (is_operator() or is_project_owner(p_project)) then
    raise exception 'Only the project owner can manage access';
  end if;
  delete from project_members where project_id = p_project and lower(email) = e;
  return e;
end $$;

-- Mentionable people: prior (non-guest) commenters + the notify list + the
-- owner, minus the caller. Fixes the long-standing bug where this gated on
-- the obsolete allowed_emails table and threw for every non-staff user.
create or replace function list_mentionable(p_project uuid)
returns table (email text, name text) language plpgsql security definer set search_path = public as $$
declare me text := lower(coalesce(auth.jwt()->>'email', ''));
begin
  if not can_read_project(p_project) or is_anonymous_session() then
    raise exception 'Not allowed';
  end if;
  return query
    with people as (
      select lower(c.author_email) as email, max(c.author_name) as name
        from comments c where c.project_id = p_project and c.author_email not like 'guest:%'
       group by lower(c.author_email)
      union
      select lower(n.email), null from notify_recipients n where n.project_id = p_project
      union
      select lower(u.email), null from projects p join auth.users u on u.id = p.owner_id where p.id = p_project
    )
    select pp.email, max(pp.name) as name from people pp
     where pp.email <> me and pp.email <> ''
     group by pp.email order by pp.email;
end $$;

do $$ begin
  execute 'revoke all on function invite_email(uuid,text,text), list_invites(uuid), revoke_invite(uuid,text), list_mentionable(uuid) from public, anon';
  execute 'grant execute on function invite_email(uuid,text,text), list_invites(uuid), revoke_invite(uuid,text), list_mentionable(uuid) to authenticated';
end $$;

-- ============================================================ 8. storage
-- Uploads must land under <project uuid>/… for a project the caller may write
-- to, that is writable, and that is under its plan's attachment quota.
create or replace function storage_upload_allowed(p_name text) returns boolean
language plpgsql security definer stable set search_path = public as $$
declare seg text := split_part(p_name, '/', 1); pid uuid; used bigint; lim bigint; owner uuid;
begin
  if seg !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  pid := seg::uuid;
  if not project_is_writable(pid) then return false; end if;
  if not (can_write_project(pid) or (project_is_open(pid) and (is_anonymous_session() or has_unlock(pid)))) then
    return false;
  end if;
  select coalesce(sum((o.metadata->>'size')::bigint), 0) into used
    from storage.objects o where o.bucket_id = 'comment-media' and o.name like seg || '/%';
  select p.owner_id into owner from projects p where p.id = pid;
  if exists (select 1 from operators x where x.user_id = owner) then return true; end if;
  select pl.attachment_bytes_limit into lim from plans pl
   where pl.id = coalesce((select s.plan from subscriptions s
                            where s.user_id = owner
                              and (s.status in ('active','trialing')
                                   or (s.status = 'past_due' and coalesce(s.grace_until,'infinity'::timestamptz) > now()))),
                          'free');
  return used < coalesce(lim, 0);
end $$;
revoke all on function storage_upload_allowed(text) from public, anon;
grant execute on function storage_upload_allowed(text) to authenticated;

drop policy if exists "comment-media auth upload" on storage.objects;
drop policy if exists "comment-media scoped upload" on storage.objects;
create policy "comment-media scoped upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'comment-media' and storage_upload_allowed(name));

drop policy if exists "comment-media delete" on storage.objects;
create policy "comment-media delete" on storage.objects for delete to authenticated using (
  bucket_id = 'comment-media' and (
    owner = auth.uid()
    or is_operator()
    or (split_part(name, '/', 1) ~ '^[0-9a-f-]{36}$' and is_project_owner(split_part(name, '/', 1)::uuid))
  )
);
-- "comment-media public read" is unchanged.

-- ============================================================ 9. backfill (guarded, ordered)
-- 9a. staff -> operators. The domain string's only surviving use: as DATA.
insert into operators (user_id, note)
select id, 'backfill: staff' from auth.users where lower(email) like '%@avalanchegr.com'
on conflict do nothing;

-- 9b. every existing project -> owned by lance; abort loudly if not found.
do $$
declare v uuid;
begin
  select id into v from auth.users where lower(email) = 'lance@avalanchegr.com';
  if v is null then raise exception 'backfill: lance@avalanchegr.com has no auth user — aborting'; end if;
  update projects set owner_id = v where owner_id is null;
end $$;
alter table projects alter column owner_id set not null;

-- 9c. secrets for every project.
insert into project_secrets (project_id, bridge_secret)
select id, encode(extensions.gen_random_bytes(24), 'hex') from projects
on conflict do nothing;

-- 9d. historical roles on comments.
update comments c set author_role = case
    when c.author_email like 'guest:%' then 'guest'
    when exists (select 1 from operators o join auth.users u on u.id = o.user_id
                  where lower(u.email) = lower(c.author_email)) then 'operator'
    else 'collaborator' end
where c.author_role is null;

-- 9e. staff rows the WP bridge created in project_members are redundant now.
delete from project_members pm
 using operators o join auth.users u on u.id = o.user_id
 where lower(pm.email) = lower(u.email);

-- 9f. the obsolete global allow-list (list_mentionable no longer reads it).
drop policy if exists "read own allow" on allowed_emails;
drop table if exists allowed_emails;

-- 9g. sweeper wiring (pg_cron may not be enabled; don't fail the migration).
do $$ begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron not available: %', sqlerrm;
  end;
end $$;
insert into private.app_settings (key, value)
values ('sweep_url', 'https://vaculezzigjtgbysnajf.supabase.co/functions/v1/media-sweep')
on conflict (key) do update set value = excluded.value;
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('media-sweep') where exists (select 1 from cron.job where jobname = 'media-sweep');
    perform cron.schedule('media-sweep', '17 * * * *', $cron$
      select net.http_post(
        url := (select value from private.app_settings where key = 'sweep_url'),
        headers := jsonb_build_object('Content-Type','application/json',
                                      'x-notify-secret', (select value from private.app_settings where key = 'notify_secret')),
        body := '{}'::jsonb)
    $cron$);
  end if;
end $$;
