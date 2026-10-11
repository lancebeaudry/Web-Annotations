-- v27c: set_design_share used gen_random_bytes(), which lives in the
-- extensions schema and isn't on this function's search path. Use the
-- built-in gen_random_uuid() for the share token instead.
create or replace function set_design_share(p_project uuid, p_on boolean) returns text
language plpgsql security definer set search_path = public as $$
declare v_tok text;
begin
  if not (is_operator() or is_project_owner(p_project)) then raise exception 'Only the project owner can change this'; end if;
  insert into design_systems (project_id) values (p_project) on conflict (project_id) do nothing;
  if coalesce(p_on, false) then
    v_tok := replace(gen_random_uuid()::text, '-', '');
    update design_systems set share_token = v_tok where project_id = p_project;
  else
    update design_systems set share_token = null where project_id = p_project;
  end if;
  return v_tok;
end $$;

-- The connector can name its own key header (some sites already expect
-- one). Same as v27 set_design_rules, plus connector.key_header.
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
  if coalesce(conn->>'key_header', '') <> '' and ((conn->>'key_header') !~ '^[A-Za-z0-9-]{1,40}$'
     or lower(conn->>'key_header') in ('host', 'content-type', 'content-length', 'cookie', 'connection', 'transfer-encoding', 'x-pinpoint-key')) then
    raise exception 'Key header must be a plain header name like X-Site-Key';
  end if;
  nxt := jsonb_build_object(
    'enabled', coalesce((p_settings->>'enabled')::boolean, (cur->>'enabled')::boolean, false),
    'approver_email', v_appr,
    'approve', case when coalesce(p_settings->>'approve', cur->>'approve') = 'collaborators' then 'collaborators' else 'managers' end,
    'exceptions', case when coalesce(p_settings->>'exceptions', cur->>'exceptions') = 'collaborators' then 'collaborators' else 'managers' end,
    'connector', jsonb_build_object(
      'base_url', nullif(trim(coalesce(conn->>'base_url', '')), ''),
      'prod_url', nullif(trim(coalesce(conn->>'prod_url', '')), ''),
      'preview_param', nullif(trim(coalesce(conn->>'preview_param', '')), ''),
      'key_header', nullif(trim(coalesce(conn->>'key_header', '')), ''))
  );
  update projects set design_rules = nxt where id = p_project;
  return nxt;
end $$;
