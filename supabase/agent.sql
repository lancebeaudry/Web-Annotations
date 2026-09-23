-- PinPoint 2.1 — AI-assistant access ("agent key").
--
-- A per-project key that lets an AI coding assistant (Claude Code, Cursor,
-- a script) reply to and resolve comments through the `agent` edge function,
-- without a user session. The key is minted lazily by the owner (or an
-- operator), lives next to the bridge secret, and is rotatable. Nothing
-- client-side can read it except through the two gated RPCs below.
--
-- Replies written by an assistant carry author_role = 'agent' so the UI and
-- exports label them honestly ("AI assistant").
--
-- Apply after tenancy.sql + dashboard.sql. Idempotent.

alter table project_secrets add column if not exists agent_key text;
alter table project_secrets add column if not exists agent_key_rotated_at timestamptz;
create unique index if not exists project_secrets_agent_key_idx on project_secrets (agent_key) where agent_key is not null;

-- Allow the new role on comments.
alter table comments drop constraint if exists comments_author_role_check;
alter table comments add constraint comments_author_role_check
  check (author_role in ('operator','owner','collaborator','guest','agent'));

create or replace function get_agent_key(p_project uuid) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare v text;
begin
  if not (is_operator() or is_project_owner(p_project)) then
    raise exception 'Only the project owner can view the AI assistant key';
  end if;
  select agent_key into v from project_secrets where project_id = p_project;
  if v is null then
    v := 'pp_' || encode(extensions.gen_random_bytes(20), 'hex');
    insert into project_secrets (project_id, bridge_secret, agent_key, agent_key_rotated_at)
    values (p_project, encode(extensions.gen_random_bytes(24), 'hex'), v, now())
    on conflict (project_id) do update set agent_key = excluded.agent_key, agent_key_rotated_at = now();
  end if;
  return v;
end $$;

create or replace function rotate_agent_key(p_project uuid) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare v text;
begin
  if not (is_operator() or is_project_owner(p_project)) then
    raise exception 'Only the project owner can rotate the AI assistant key';
  end if;
  v := 'pp_' || encode(extensions.gen_random_bytes(20), 'hex');
  insert into project_secrets (project_id, bridge_secret, agent_key, agent_key_rotated_at)
  values (p_project, encode(extensions.gen_random_bytes(24), 'hex'), v, now())
  on conflict (project_id) do update set agent_key = excluded.agent_key, agent_key_rotated_at = now();
  return v;
end $$;

revoke all on function get_agent_key(uuid), rotate_agent_key(uuid) from public, anon;
grant execute on function get_agent_key(uuid), rotate_agent_key(uuid) to authenticated;
