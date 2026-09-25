-- PinPoint 2.3.3 — per-project triage switches.
-- Owners can hide status, effort, assignee and labels on a project that
-- doesn't need them (a one-page review, a client who only wants a list).
-- Stored as one jsonb so adding a switch later is a default, not a column.

alter table projects add column if not exists triage jsonb not null
  default '{"status":true,"effort":true,"assignee":true,"labels":true}'::jsonb;

create or replace function update_triage_settings(p_project uuid, p_triage jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if not (is_operator() or is_project_owner(p_project)) then raise exception 'Only the project owner can change this'; end if;
  v := jsonb_build_object(
    'status',   coalesce((p_triage->>'status')::boolean, true),
    'effort',   coalesce((p_triage->>'effort')::boolean, true),
    'assignee', coalesce((p_triage->>'assignee')::boolean, true),
    'labels',   coalesce((p_triage->>'labels')::boolean, true));
  update projects set triage = v where id = p_project;
  return v;
end $$;
revoke all on function update_triage_settings(uuid, jsonb) from public, anon;
grant execute on function update_triage_settings(uuid, jsonb) to authenticated;

create or replace function my_project_role(p_project uuid) returns jsonb
language plpgsql security definer stable set search_path = public as $$
declare r text; v_owner uuid; v_plan text; pl plans; v_auto boolean; v_weekly boolean; v_triage jsonb;
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
  select owner_id, auto_screenshot, digest_weekly, triage into v_owner, v_auto, v_weekly, v_triage from projects where id = p_project;
  v_plan := plan_of(v_owner);
  select * into pl from plans where id = v_plan;
  return jsonb_build_object(
    'role', r,
    'writable', r <> 'none' and project_is_writable(p_project),
    'plan', v_plan,
    'auto_screenshot', coalesce(v_auto, true),
    'digest_weekly', coalesce(v_weekly, false),
    'triage', coalesce(v_triage, '{"status":true,"effort":true,"assignee":true,"labels":true}'::jsonb),
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
notify pgrst, 'reload schema';
