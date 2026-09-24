-- PinPoint 2.2.3 — AI replies post as a person by default.
--
-- Replies written through the agent key used to carry author_role = 'agent'
-- and show up everywhere as "Claude Code (AI assistant)". Owners would rather
-- the reply read as the human who ran the assistant. So: each project names
-- the person AI replies appear as (default: the owner), and can opt in to the
-- AI label instead. The agent name is always kept on the row (via_agent) so
-- the record is honest even when the label is off.

alter table projects add column if not exists agent_as_email text;
alter table projects add column if not exists agent_as_name text;
alter table projects add column if not exists agent_label boolean not null default false;
alter table comments add column if not exists via_agent text;

-- Who AI replies should post as, resolved for the agent endpoints
-- (service role). Owners/operators can read it through the RPC too.
create or replace function agent_persona(p_project uuid) returns jsonb
language plpgsql security definer stable set search_path = public as $$
declare v projects; v_owner_email text; v_email text; v_name text; v_role text;
begin
  select * into v from projects where id = p_project;
  if v.id is null then return null; end if;
  select lower(email) into v_owner_email from auth.users where id = v.owner_id;
  if auth.uid() is not null and not (is_operator() or is_project_owner(p_project)) then
    raise exception 'Only the project owner can view this';
  end if;
  if v.agent_label then
    return jsonb_build_object('label', true, 'email', 'agent:' || p_project, 'name', null, 'role', 'agent', 'owner_email', v_owner_email);
  end if;
  v_email := coalesce(nullif(lower(v.agent_as_email), ''), v_owner_email);
  v_name := coalesce(nullif(v.agent_as_name, ''), initcap(replace(split_part(v_email, '@', 1), '.', ' ')));
  if v_email = v_owner_email then
    v_role := case when exists (select 1 from operators o where o.user_id = v.owner_id) then 'operator' else 'owner' end;
  elsif exists (select 1 from operators o join auth.users u on u.id = o.user_id where lower(u.email) = v_email) then
    v_role := 'operator';
  else
    v_role := 'collaborator';
  end if;
  return jsonb_build_object('label', false, 'email', v_email, 'name', v_name, 'role', v_role, 'owner_email', v_owner_email);
end $$;

-- Owner/operator sets the persona. Email must be the owner or an invited
-- collaborator (or an operator) so the assistant can't impersonate a stranger.
create or replace function update_agent_settings(p_project uuid, p_email text, p_name text, p_label boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_email text := nullif(lower(trim(coalesce(p_email, ''))), ''); v_owner uuid; v_owner_email text;
begin
  if not (is_operator() or is_project_owner(p_project)) then raise exception 'Only the project owner can change this'; end if;
  select owner_id into v_owner from projects where id = p_project;
  select lower(email) into v_owner_email from auth.users where id = v_owner;
  if v_email is not null and v_email <> v_owner_email
     and not exists (select 1 from project_members m where m.project_id = p_project and lower(m.email) = v_email)
     and not exists (select 1 from operators o join auth.users u on u.id = o.user_id where lower(u.email) = v_email) then
    raise exception 'Pick the owner or an invited collaborator';
  end if;
  update projects set agent_as_email = v_email, agent_as_name = nullif(trim(coalesce(p_name, '')), ''), agent_label = coalesce(p_label, false)
   where id = p_project;
  return agent_persona(p_project);
end $$;

revoke all on function agent_persona(uuid), update_agent_settings(uuid, text, text, boolean) from public, anon;
grant execute on function agent_persona(uuid), update_agent_settings(uuid, text, text, boolean) to authenticated, service_role;
