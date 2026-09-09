-- Avalanche Markup 2.0 — dashboard RPCs. Run AFTER tenancy.sql.
--
-- notify_recipients has RLS with zero policies (service role only), because
-- it is a per-project email list that must never leak across tenants. The
-- dashboard edits it through these owner-gated functions. The WordPress
-- notify-sync bridge keeps writing it with the service role, unchanged.

create or replace function list_notify_recipients(p_project uuid)
returns setof text language plpgsql security definer set search_path = public as $$
begin
  if not (is_operator() or is_project_owner(p_project)) then
    raise exception 'Only the project owner can view notifications';
  end if;
  return query select email from notify_recipients where project_id = p_project order by email;
end $$;

create or replace function set_notify_recipients(p_project uuid, p_emails text[])
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not (is_operator() or is_project_owner(p_project)) then
    raise exception 'Only the project owner can change notifications';
  end if;
  delete from notify_recipients where project_id = p_project;
  insert into notify_recipients (project_id, email)
  select p_project, e from (
    select distinct lower(trim(x)) as e from unnest(coalesce(p_emails, '{}')) x
  ) s where e like '%@%';
  get diagnostics n = row_count;
  return n;
end $$;

-- Project settings the owner may change from the dashboard (name, site,
-- open feedback). Goes through a function so the row-level UPDATE policy
-- stays simple and no other column is reachable.
create or replace function update_project_settings(p_project uuid, p_name text, p_site_url text, p_open_access boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (is_operator() or is_project_owner(p_project)) then
    raise exception 'Only the project owner can change settings';
  end if;
  update projects
     set name = coalesce(nullif(trim(p_name), ''), name),
         site_url = coalesce(nullif(trim(p_site_url), ''), site_url),
         open_access = coalesce(p_open_access, open_access)
   where id = p_project;
end $$;

-- Used by the wp-session bridge (service role) to decide whether an email
-- may be minted a session for a project: operator | owner | collaborator |
-- none. Operators are refused by the caller — staff never auto-sign-in on a
-- customer's server.
create or replace function bridge_user_access(p_project uuid, p_email text)
returns text language sql security definer stable set search_path = public as $$
  select case
    when exists (select 1 from operators o join auth.users u on u.id = o.user_id
                  where lower(u.email) = lower(trim(p_email))) then 'operator'
    when exists (select 1 from projects p join auth.users u on u.id = p.owner_id
                  where p.id = p_project and lower(u.email) = lower(trim(p_email))) then 'owner'
    when exists (select 1 from project_members pm
                  where pm.project_id = p_project and lower(pm.email) = lower(trim(p_email))) then 'collaborator'
    else 'none' end;
$$;
revoke all on function bridge_user_access(uuid, text) from public, anon, authenticated;

do $$ begin
  execute 'revoke all on function list_notify_recipients(uuid), set_notify_recipients(uuid,text[]), update_project_settings(uuid,text,text,boolean) from public, anon';
  execute 'grant execute on function list_notify_recipients(uuid), set_notify_recipients(uuid,text[]), update_project_settings(uuid,text,text,boolean) to authenticated';
end $$;
