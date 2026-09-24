-- PinPoint 2.2 — plans with caps, feedback inbox, page approvals, integrations.
--
--   plans        free (1 site, 50 comments, 10 images) / pro (10 sites) / agency (unlimited)
--   features     agency-only: integrations (Slack, ClickUp) and page approvals
--   comments     status open|in_progress|resolved|wont_fix, assignee_email,
--                context (browser + console capture), external_ref (ClickUp task)
--   approvals    page_approvals: an approved page accepts no new pins until reopened
--   integrations per-project Slack webhook / ClickUp token+list, read only by
--                the service role (functions); secrets never reach the browser
--
-- Apply after agent.sql. Idempotent.

-- ============================================================ 1. plans
alter table plans add column if not exists comment_limit integer;   -- null = unlimited, per project
alter table plans add column if not exists image_limit   integer;   -- null = unlimited, per project
alter table plans add column if not exists features      text[] not null default '{}';
insert into plans (id, project_limit, attachment_bytes_limit, comment_limit, image_limit, features) values
  ('free',   1,          104857600,  50,   10,   '{}'),
  ('pro',    10,         5368709120, null, null, '{}'),
  ('agency', 2147483647, 21474836480, null, null, '{integrations,approvals}')
on conflict (id) do update set project_limit = excluded.project_limit,
                               attachment_bytes_limit = excluded.attachment_bytes_limit,
                               comment_limit = excluded.comment_limit,
                               image_limit = excluded.image_limit,
                               features = excluded.features;

alter table subscriptions drop constraint if exists subscriptions_plan_check;
alter table subscriptions add constraint subscriptions_plan_check check (plan in ('free','pro','agency'));

-- The owner's effective plan id (same lapse/grace rules as before), in one place.
create or replace function plan_of(p_user uuid) returns text
language sql security definer stable set search_path = public as $$
  select case
    when exists (select 1 from operators o where o.user_id = p_user) then 'agency'
    else coalesce((
      select s.plan from subscriptions s
       where s.user_id = p_user and s.plan <> 'free'
         and (s.status in ('active','trialing')
              or (s.status = 'past_due' and coalesce(s.grace_until, 'infinity'::timestamptz) > now()))
         and (s.current_period_end is null or s.current_period_end > now()
              or (s.status = 'past_due' and coalesce(s.grace_until, 'infinity'::timestamptz) > now()))
    ), 'free')
  end;
$$;

create or replace function effective_project_limit(p_user uuid) returns integer
language sql security definer stable set search_path = public as $$
  select case when exists (select 1 from operators o where o.user_id = p_user) then 2147483647
              else (select project_limit from plans where id = plan_of(p_user)) end;
$$;

create or replace function plan_has(p_user uuid, p_feature text) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from operators o where o.user_id = p_user)
      or coalesce((select p_feature = any (pl.features) from plans pl where pl.id = plan_of(p_user)), false);
$$;

create or replace function project_owner(p_project uuid) returns uuid
language sql security definer stable set search_path = public as $$
  select owner_id from projects where id = p_project;
$$;

-- ============================================================ 2. comments: inbox columns
alter table comments drop constraint if exists comments_status_check;
alter table comments add constraint comments_status_check check (status in ('open','in_progress','resolved','wont_fix'));
alter table comments add column if not exists assignee_email text;
alter table comments add column if not exists context      jsonb;   -- {ua, viewport, dpr, errors[], failed[]}
alter table comments add column if not exists external_ref jsonb;   -- {clickup_task_id, slack_ts}
create index if not exists comments_status_idx on comments (project_id, status);

create or replace function project_comment_count(p_project uuid) returns integer
language sql security definer stable set search_path = public as $$
  select count(*)::int from comments where project_id = p_project;
$$;
create or replace function project_image_count(p_project uuid) returns integer
language sql security definer stable set search_path = public as $$
  select count(*)::int from storage.objects o
   where o.bucket_id = 'comment-media' and o.name like p_project::text || '/%';
$$;

-- ============================================================ 3. page approvals
create table if not exists page_approvals (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references projects(id) on delete cascade,
  page_path        text not null,
  approved_by_email text not null,
  approved_by_name  text,
  approved_role    text,
  note             text,
  created_at       timestamptz not null default now(),
  revoked_at       timestamptz,
  revoked_by_email text
);
create index if not exists page_approvals_active_idx on page_approvals (project_id, page_path) where revoked_at is null;
alter table page_approvals enable row level security;
drop policy if exists "read approvals" on page_approvals;
create policy "read approvals" on page_approvals for select using (can_read_project(project_id));
-- writes only through the RPCs below

create or replace function page_is_approved(p_project uuid, p_page text) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from page_approvals a
                  where a.project_id = p_project and a.page_path = p_page and a.revoked_at is null);
$$;

create or replace function approve_page(p_project uuid, p_page text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r text; v_email text; v_name text; row_ page_approvals;
begin
  if auth.uid() is null or is_anonymous_session() then raise exception 'Sign in to approve a page'; end if;
  if not plan_has(project_owner(p_project), 'approvals') then
    raise exception 'PLAN_FEATURE_REQUIRED' using hint = 'Page approvals are part of the Agency plan.';
  end if;
  r := my_project_role(p_project)->>'role';
  if r not in ('operator','owner','collaborator') then raise exception 'Only the owner and invited collaborators can approve pages'; end if;
  select email into v_email from auth.users where id = auth.uid();
  v_name := (select raw_user_meta_data->>'full_name' from auth.users where id = auth.uid());
  update page_approvals set revoked_at = now(), revoked_by_email = v_email
   where project_id = p_project and page_path = p_page and revoked_at is null;
  insert into page_approvals (project_id, page_path, approved_by_email, approved_by_name, approved_role, note)
  values (p_project, p_page, lower(v_email), v_name, r, p_note) returning * into row_;
  return to_jsonb(row_);
end $$;

create or replace function revoke_approval(p_project uuid, p_page text) returns void
language plpgsql security definer set search_path = public as $$
declare r text; v_email text;
begin
  if auth.uid() is null or is_anonymous_session() then raise exception 'Sign in first'; end if;
  r := my_project_role(p_project)->>'role';
  select lower(email) into v_email from auth.users where id = auth.uid();
  update page_approvals set revoked_at = now(), revoked_by_email = v_email
   where project_id = p_project and page_path = p_page and revoked_at is null
     and (r in ('operator','owner') or approved_by_email = v_email);
  if not found then raise exception 'Nothing to reopen, or not allowed'; end if;
end $$;

-- ============================================================ 4. integrations
create table if not exists integrations (
  project_id uuid not null references projects(id) on delete cascade,
  kind       text not null check (kind in ('slack','clickup')),
  config     jsonb not null default '{}',    -- slack: {webhook_url}; clickup: {token, list_id, list_name}
  enabled    boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, kind)
);
alter table integrations enable row level security;   -- zero policies: RPCs + service role only

create or replace function set_integration(p_project uuid, p_kind text, p_config jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (is_operator() or is_project_owner(p_project)) then raise exception 'Only the project owner can manage integrations'; end if;
  if not plan_has(project_owner(p_project), 'integrations') then
    raise exception 'PLAN_FEATURE_REQUIRED' using hint = 'Integrations are part of the Agency plan.';
  end if;
  insert into integrations (project_id, kind, config) values (p_project, p_kind, coalesce(p_config, '{}'))
  on conflict (project_id, kind) do update set config = excluded.config, enabled = true, updated_at = now();
end $$;

create or replace function remove_integration(p_project uuid, p_kind text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (is_operator() or is_project_owner(p_project)) then raise exception 'Only the project owner can manage integrations'; end if;
  delete from integrations where project_id = p_project and kind = p_kind;
end $$;

-- Masked view for the dashboard: never returns the token / webhook secret path.
create or replace function get_integrations(p_project uuid) returns jsonb
language plpgsql security definer stable set search_path = public as $$
begin
  if not (is_operator() or is_project_owner(p_project)) then raise exception 'Only the project owner can view integrations'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'kind', i.kind, 'enabled', i.enabled, 'updated_at', i.updated_at,
      'summary', case i.kind
        when 'slack'   then 'Webhook …' || right(i.config->>'webhook_url', 8)
        when 'clickup' then coalesce(i.config->>'list_name', 'list ' || (i.config->>'list_id'))
      end))
    from integrations i where i.project_id = p_project), '[]'::jsonb);
end $$;

-- ============================================================ 5. role/account payloads
create or replace function my_project_role(p_project uuid) returns jsonb
language plpgsql security definer stable set search_path = public as $$
declare r text; v_owner uuid; v_plan text; pl plans;
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
  v_owner := project_owner(p_project);
  v_plan := plan_of(v_owner);
  select * into pl from plans where id = v_plan;
  return jsonb_build_object(
    'role', r,
    'writable', r <> 'none' and project_is_writable(p_project),
    'plan', v_plan,
    'comment_limit', pl.comment_limit,
    'comment_count', case when r = 'none' then null else project_comment_count(p_project) end,
    'image_limit', pl.image_limit,
    'image_count', case when r = 'none' then null else project_image_count(p_project) end,
    'features', to_jsonb(coalesce(pl.features, '{}')),
    'approved_pages', case when r = 'none' then '[]'::jsonb else coalesce((
        select jsonb_agg(jsonb_build_object('page_path', a.page_path, 'by', coalesce(a.approved_by_name, a.approved_by_email), 'email', a.approved_by_email, 'at', a.created_at))
          from page_approvals a where a.project_id = p_project and a.revoked_at is null), '[]'::jsonb) end
  );
end $$;

create or replace function my_account() returns jsonb
language plpgsql security definer stable set search_path = public as $$
declare v_status text; v_end timestamptz; v_cancel boolean; v_plan text;
begin
  if auth.uid() is null then return jsonb_build_object('signed_in', false); end if;
  select s.status, s.current_period_end, s.cancel_at_period_end
    into v_status, v_end, v_cancel from subscriptions s where s.user_id = auth.uid();
  v_plan := plan_of(auth.uid());
  return jsonb_build_object(
    'signed_in', true,
    'is_operator', is_operator(),
    'plan', case when is_operator() then 'agency' else v_plan end,
    'status', coalesce(v_status, 'none'),
    'current_period_end', v_end,
    'cancel_at_period_end', coalesce(v_cancel, false),
    'project_limit', effective_project_limit(auth.uid()),
    'owned_count', owned_project_count(auth.uid()),
    'features', to_jsonb((select features from plans where id = v_plan)),
    'limits', (select jsonb_build_object('comments', comment_limit, 'images', image_limit) from plans where id = v_plan)
  );
end $$;

-- ============================================================ 6. write guards
-- comments: role stamp (as before) + free-plan comment cap + approved-page lock.
create or replace function comments_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_owner uuid; v_lim integer;
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then
      new.author_role := (my_project_role(new.project_id)->>'role');
      if new.author_role = 'none' then new.author_role := 'guest'; end if;
    end if;
    if new.parent_id is null and page_is_approved(new.project_id, new.page_path) then
      raise exception 'PAGE_APPROVED' using errcode = 'check_violation',
        hint = 'This page has been approved. Reopen it to add comments.';
    end if;
    v_owner := project_owner(new.project_id);
    if not exists (select 1 from operators o where o.user_id = v_owner) then
      select comment_limit into v_lim from plans where id = plan_of(v_owner);
      if v_lim is not null and project_comment_count(new.project_id) >= v_lim then
        raise exception 'COMMENT_LIMIT_REACHED' using errcode = 'check_violation',
          hint = 'The free plan includes 50 comments per project. Upgrade to keep going.';
      end if;
    end if;
    if new.assignee_email is not null then new.assignee_email := lower(new.assignee_email); end if;
  elsif tg_op = 'UPDATE' and auth.uid() is not null then
    if new.project_id <> old.project_id or new.author_email <> old.author_email
       or new.author_role is distinct from old.author_role
       or new.parent_id is distinct from old.parent_id then
      raise exception 'immutable column';
    end if;
    if new.assignee_email is not null then new.assignee_email := lower(new.assignee_email); end if;
  end if;
  return new;
end $$;

-- comments UPDATE: as before, plus the assignee may work their own items.
drop policy if exists "update own or team" on comments;
drop policy if exists "update comments" on comments;
create policy "update comments" on comments for update
  using (
    project_is_writable(project_id) and (
      is_operator() or is_project_owner(project_id)
      or lower(author_email) = lower(coalesce(auth.email(), ''))
      or author_email = 'guest:' || auth.uid()::text
      or lower(coalesce(assignee_email, '')) = lower(coalesce(auth.email(), ''))
    )
  )
  with check (project_is_writable(project_id));

-- storage: free-plan image cap on top of the byte quota.
create or replace function storage_upload_allowed(p_name text) returns boolean
language plpgsql security definer stable set search_path = public as $$
declare seg text := split_part(p_name, '/', 1); pid uuid; used bigint; lim bigint; owner uuid; pl plans;
begin
  if seg !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  pid := seg::uuid;
  if not project_is_writable(pid) then return false; end if;
  if not (can_write_project(pid) or (project_is_open(pid) and (is_anonymous_session() or has_unlock(pid)))) then
    return false;
  end if;
  select p.owner_id into owner from projects p where p.id = pid;
  if exists (select 1 from operators x where x.user_id = owner) then return true; end if;
  select * into pl from plans where id = plan_of(owner);
  if pl.image_limit is not null and project_image_count(pid) >= pl.image_limit then return false; end if;
  select coalesce(sum((o.metadata->>'size')::bigint), 0) into used
    from storage.objects o where o.bucket_id = 'comment-media' and o.name like seg || '/%';
  return used < coalesce(pl.attachment_bytes_limit, 0);
end $$;

-- ============================================================ 7. status changes reach the notifier (Slack / ClickUp)
create or replace function public.notify_on_comment_update()
returns trigger language plpgsql security definer
set search_path = public, extensions as $fn$
declare v_url text; v_secret text;
begin
  if new.status is not distinct from old.status and new.assignee_email is not distinct from old.assignee_email then
    return new;
  end if;
  select value into v_url    from private.app_settings where key = 'notify_url';
  select value into v_secret from private.app_settings where key = 'notify_secret';
  if v_url is null then return new; end if;
  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-notify-secret', coalesce(v_secret, '')),
    body    := jsonb_build_object('event', 'update', 'record', row_to_json(new)::jsonb, 'old_record', row_to_json(old)::jsonb)
  );
  return new;
end; $fn$;
drop trigger if exists comments_notify_update on comments;
create trigger comments_notify_update after update on comments
  for each row execute function public.notify_on_comment_update();

-- ============================================================ 8. grants
revoke all on function plan_of(uuid), plan_has(uuid, text), project_owner(uuid), project_comment_count(uuid), project_image_count(uuid),
  page_is_approved(uuid, text), approve_page(uuid, text, text), revoke_approval(uuid, text),
  set_integration(uuid, text, jsonb), remove_integration(uuid, text), get_integrations(uuid),
  my_project_role(uuid), my_account(), effective_project_limit(uuid), storage_upload_allowed(text) from public, anon;
grant execute on function plan_of(uuid), plan_has(uuid, text), project_owner(uuid), project_comment_count(uuid), project_image_count(uuid),
  page_is_approved(uuid, text), approve_page(uuid, text, text), revoke_approval(uuid, text),
  set_integration(uuid, text, jsonb), remove_integration(uuid, text), get_integrations(uuid),
  my_project_role(uuid), my_account(), effective_project_limit(uuid), storage_upload_allowed(text) to authenticated;
