-- PinPoint 2.7 — design rules.
--
-- A project can keep a design system (colors, type, radius, spacing,
-- buttons, surfaces, variants, rules) in PinPoint. Reviewers ask for a style
-- change from a pin; PinPoint checks it and offers three choices: use the
-- closest approved style, log a one-off exception, or change the rule
-- (proposal -> approve). An optional site connector (the WordPress rules
-- API) lets PinPoint apply changes and build previews on staging.
--
-- Everything is off unless projects.design_rules.enabled is true and the
-- owner's plan has the 'design_rules' feature (Agency; operators always).
-- All writes to design data go through the design-rules edge function
-- (service role) or the owner RPCs below; nothing here is client-writable.

-- ---------------------------------------------------------------- columns
alter table projects add column if not exists design_rules jsonb not null default '{}'::jsonb;
-- { enabled, approver_email, approve: 'managers'|'collaborators', exceptions: 'managers'|'collaborators',
--   connector: { base_url, prod_url, preview_param } }
alter table project_secrets add column if not exists design_connector_key text;
alter table project_secrets add column if not exists design_connector_prod_key text;
alter table comments add column if not exists design_check jsonb;
alter table comments add column if not exists preview_id text;

update plans set features = array(select distinct unnest(features || array['design_rules'])) where id = 'agency';

-- ------------------------------------------------------------------ tables
create table if not exists design_systems (
  project_id uuid primary key references projects(id) on delete cascade,
  tokens jsonb not null default '{}'::jsonb,
  version text not null default '1.0.0',
  updated_at timestamptz not null default now(),
  updated_by text,
  source text not null default 'pinpoint',      -- pinpoint | connector
  share_token text unique
);
create table if not exists design_proposals (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  comment_id uuid references comments(id) on delete set null,
  summary text not null,
  changes jsonb not null,
  then_apply jsonb,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  requested_by text not null,
  decided_by text,
  decided_at timestamptz,
  version_from text,
  version_to text,
  affected jsonb not null default '[]'::jsonb,
  connector_id text,
  created_at timestamptz not null default now()
);
create index if not exists design_proposals_project_idx on design_proposals (project_id, status, created_at desc);
create table if not exists design_exceptions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  comment_id uuid references comments(id) on delete set null,
  page_path text, selector text, property text not null, value text not null,
  reason text not null,
  created_by text not null,
  connector_id text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists design_exceptions_project_idx on design_exceptions (project_id, created_at desc);
create table if not exists design_changelog (
  id bigserial primary key,
  project_id uuid not null references projects(id) on delete cascade,
  version text not null,
  kind text not null,                -- import | rule_change | edit | exception
  summary text not null,
  changes jsonb,
  by text,
  at timestamptz not null default now()
);
create index if not exists design_changelog_project_idx on design_changelog (project_id, at desc);
create table if not exists design_rule_hits (
  user_id uuid not null,
  at timestamptz not null default now()
);
create index if not exists design_rule_hits_idx on design_rule_hits (user_id, at);

alter table design_systems enable row level security;
alter table design_proposals enable row level security;
alter table design_exceptions enable row level security;
alter table design_changelog enable row level security;
alter table design_rule_hits enable row level security;

-- Members (operator, owner, collaborators) can read. No client writes.
drop policy if exists "members read design system" on design_systems;
create policy "members read design system" on design_systems for select using (can_write_project(project_id));
drop policy if exists "members read design proposals" on design_proposals;
create policy "members read design proposals" on design_proposals for select using (can_write_project(project_id));
drop policy if exists "members read design exceptions" on design_exceptions;
create policy "members read design exceptions" on design_exceptions for select using (can_write_project(project_id));
drop policy if exists "members read design changelog" on design_changelog;
create policy "members read design changelog" on design_changelog for select using (can_write_project(project_id));

-- ---------------------------------------- design_check is server-written
-- Any author may update their own comment row, so without this a client
-- could forge an "approved" result. Separate from comments_before_write so
-- the comment cap and approved-page lock stay untouched.
create or replace function comments_guard_design_check() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null then
    if tg_op = 'INSERT' and new.design_check is not null then
      raise exception 'DESIGN_CHECK_SERVER_ONLY' using errcode = 'check_violation';
    end if;
    if tg_op = 'UPDATE' and new.design_check is distinct from old.design_check then
      raise exception 'DESIGN_CHECK_SERVER_ONLY' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists comments_guard_design_check on comments;
create trigger comments_guard_design_check before insert or update on comments
  for each row execute function comments_guard_design_check();

-- --------------------------------------------------------------- helpers
-- What the signed-in user may do with this project's design rules.
create or replace function design_rules_access(p_project uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v projects; v_on boolean; v_plan boolean; v_mgr boolean; v_collab boolean; v_ownerish boolean;
begin
  select * into v from projects where id = p_project;
  if v.id is null or auth.uid() is null then return jsonb_build_object('enabled', false); end if;
  v_plan := plan_has(v.owner_id, 'design_rules');
  v_on := coalesce((v.design_rules->>'enabled')::boolean, false) and v_plan;
  v_ownerish := is_operator() or v.owner_id = auth.uid();
  v_mgr := v_ownerish or is_project_manager(p_project);
  v_collab := v_mgr or is_project_collaborator(p_project);
  return jsonb_build_object(
    'enabled', v_on,
    'plan_ok', v_plan,
    'can_check', v_on and v_collab,
    'can_approve', v_on and (v_mgr or (coalesce(v.design_rules->>'approve', 'managers') = 'collaborators' and v_collab)),
    'can_except', v_on and (v_mgr or (coalesce(v.design_rules->>'exceptions', 'managers') = 'collaborators' and v_collab)),
    'can_revert', v_on and v_mgr,
    'connected', v_on and coalesce(v.design_rules->'connector'->>'base_url', '') <> '',
    'preview_param', coalesce(nullif(v.design_rules->'connector'->>'preview_param', ''), 'pp_preview'),
    'version', (select d.version from design_systems d where d.project_id = p_project)
  );
end $$;

-- my_project_role: same as v26 plus design_rules.
create or replace function my_project_role(p_project uuid) returns jsonb
language plpgsql security definer stable set search_path = public as $$
declare r text; v_owner uuid; v_plan text; pl plans; v_auto boolean; v_weekly boolean; v_triage jsonb; v_mode text;
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
  select owner_id, auto_screenshot, digest_weekly, triage, notify_mode into v_owner, v_auto, v_weekly, v_triage, v_mode from projects where id = p_project;
  v_plan := plan_of(v_owner);
  select * into pl from plans where id = v_plan;
  return jsonb_build_object(
    'role', r,
    'manager', r = 'collaborator' and is_project_manager(p_project),
    'writable', r <> 'none' and project_is_writable(p_project),
    'plan', v_plan,
    'auto_screenshot', coalesce(v_auto, true),
    'digest_weekly', coalesce(v_weekly, false),
    'notify_mode', coalesce(v_mode, 'daily'),
    'triage', coalesce(v_triage, '{"status":true,"effort":true,"assignee":true,"labels":true}'::jsonb),
    'design_rules', case when r in ('operator', 'owner', 'collaborator') then design_rules_access(p_project) else jsonb_build_object('enabled', false) end,
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

-- ------------------------------------------------- owner settings RPCs
create or replace function set_design_rules(p_project uuid, p_settings jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cur jsonb; nxt jsonb; v_owner uuid; v_owner_email text; v_appr text; conn jsonb;
begin
  if not (is_operator() or is_project_owner(p_project)) then raise exception 'Only the project owner can change this'; end if;
  select design_rules, owner_id into cur, v_owner from projects where id = p_project;
  select lower(email) into v_owner_email from auth.users where id = v_owner;
  v_appr := nullif(lower(trim(coalesce(p_settings->>'approver_email', cur->>'approver_email', ''))), '');
  if v_appr is not null and v_appr <> v_owner_email
     and not exists (select 1 from project_members m where m.project_id = p_project and lower(m.email) = v_appr) then
    raise exception 'The approver must be the owner or an invited collaborator';
  end if;
  conn := coalesce(cur->'connector', '{}'::jsonb) || coalesce(p_settings->'connector', '{}'::jsonb);
  if coalesce(conn->>'base_url', '') <> '' and (conn->>'base_url') !~ '^https?://' then raise exception 'The site rules API must start with https://'; end if;
  if coalesce(conn->>'prod_url', '') <> '' and (conn->>'prod_url') !~ '^https?://' then raise exception 'The production rules API must start with https://'; end if;
  if coalesce(conn->>'preview_param', '') <> '' and (conn->>'preview_param') !~ '^[a-z0-9_]{1,40}$' then raise exception 'Preview parameter can only use a-z, 0-9 and _'; end if;
  nxt := jsonb_build_object(
    'enabled', coalesce((p_settings->>'enabled')::boolean, (cur->>'enabled')::boolean, false),
    'approver_email', v_appr,
    'approve', case when coalesce(p_settings->>'approve', cur->>'approve') = 'collaborators' then 'collaborators' else 'managers' end,
    'exceptions', case when coalesce(p_settings->>'exceptions', cur->>'exceptions') = 'collaborators' then 'collaborators' else 'managers' end,
    'connector', jsonb_build_object(
      'base_url', nullif(trim(coalesce(conn->>'base_url', '')), ''),
      'prod_url', nullif(trim(coalesce(conn->>'prod_url', '')), ''),
      'preview_param', nullif(trim(coalesce(conn->>'preview_param', '')), ''))
  );
  update projects set design_rules = nxt where id = p_project;
  return nxt;
end $$;

create or replace function set_design_connector_key(p_project uuid, p_key text, p_prod boolean default false) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not (is_operator() or is_project_owner(p_project)) then raise exception 'Only the project owner can change this'; end if;
  insert into project_secrets (project_id) values (p_project) on conflict (project_id) do nothing;
  if coalesce(p_prod, false) then
    update project_secrets set design_connector_prod_key = nullif(trim(p_key), '') where project_id = p_project;
  else
    update project_secrets set design_connector_key = nullif(trim(p_key), '') where project_id = p_project;
  end if;
  return true;
end $$;

-- Which connector keys are set (never the keys themselves).
create or replace function design_connector_status(p_project uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not (is_operator() or is_project_owner(p_project)) then raise exception 'Only the project owner can view this'; end if;
  return (select jsonb_build_object('key_set', s.design_connector_key is not null, 'prod_key_set', s.design_connector_prod_key is not null)
            from project_secrets s where s.project_id = p_project);
end $$;

create or replace function save_design_tokens(p_project uuid, p_tokens jsonb, p_summary text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_email text; v_version text;
begin
  if not (is_operator() or is_project_owner(p_project)) then raise exception 'Only the project owner can change this'; end if;
  if jsonb_typeof(p_tokens) <> 'object' or p_tokens->'color' is null then raise exception 'The design system needs at least a color section'; end if;
  if octet_length(p_tokens::text) > 200000 then raise exception 'That design system is too large'; end if;
  select lower(email) into v_email from auth.users where id = auth.uid();
  v_version := coalesce(nullif(p_tokens->>'version', ''), '1.0.0');
  insert into design_systems (project_id, tokens, version, updated_at, updated_by, source)
    values (p_project, p_tokens, v_version, now(), v_email, 'pinpoint')
    on conflict (project_id) do update set tokens = excluded.tokens, version = excluded.version, updated_at = now(), updated_by = excluded.updated_by, source = 'pinpoint';
  insert into design_changelog (project_id, version, kind, summary, by) values (p_project, v_version, 'edit', coalesce(nullif(p_summary, ''), 'Design system edited in PinPoint'), v_email);
  return jsonb_build_object('version', v_version);
end $$;

create or replace function set_design_share(p_project uuid, p_on boolean) returns text
language plpgsql security definer set search_path = public as $$
declare v_tok text;
begin
  if not (is_operator() or is_project_owner(p_project)) then raise exception 'Only the project owner can change this'; end if;
  insert into design_systems (project_id) values (p_project) on conflict (project_id) do nothing;
  if coalesce(p_on, false) then
    v_tok := encode(gen_random_bytes(12), 'hex');
    update design_systems set share_token = v_tok where project_id = p_project;
  else
    update design_systems set share_token = null where project_id = p_project;
  end if;
  return v_tok;
end $$;

-- Public, view-only: the design system behind a share link. Nothing else.
create or replace function get_shared_design_system(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('name', p.name, 'tokens', d.tokens, 'version', d.version, 'updated_at', d.updated_at,
    'exceptions', (select count(*) from design_exceptions e where e.project_id = p.id and e.active))
    from design_systems d join projects p on p.id = d.project_id
   where d.share_token is not null and d.share_token = p_token
     and coalesce((p.design_rules->>'enabled')::boolean, false);
$$;

revoke all on function design_rules_access(uuid), set_design_rules(uuid, jsonb), set_design_connector_key(uuid, text, boolean),
  design_connector_status(uuid), save_design_tokens(uuid, jsonb, text), set_design_share(uuid, boolean) from public, anon;
grant execute on function design_rules_access(uuid), set_design_rules(uuid, jsonb), set_design_connector_key(uuid, text, boolean),
  design_connector_status(uuid), save_design_tokens(uuid, jsonb, text), set_design_share(uuid, boolean) to authenticated;
revoke all on function get_shared_design_system(text) from public;
grant execute on function get_shared_design_system(text) to anon, authenticated;

notify pgrst, 'reload schema';
