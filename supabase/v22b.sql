-- 2.2 addendum: per-project auto-screenshot switch, surfaced through the role
-- payload (the overlay already calls my_project_role) and settable from the
-- dashboard via update_project_settings.
alter table projects add column if not exists auto_screenshot boolean not null default true;

create or replace function my_project_role(p_project uuid) returns jsonb
language plpgsql security definer stable set search_path = public as $$
declare r text; v_owner uuid; v_plan text; pl plans; v_auto boolean;
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
  select owner_id, auto_screenshot into v_owner, v_auto from projects where id = p_project;
  v_plan := plan_of(v_owner);
  select * into pl from plans where id = v_plan;
  return jsonb_build_object(
    'role', r,
    'writable', r <> 'none' and project_is_writable(p_project),
    'plan', v_plan,
    'auto_screenshot', coalesce(v_auto, true),
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

drop function if exists update_project_settings(uuid, text, text, boolean);
create or replace function update_project_settings(p_project uuid, p_name text, p_site_url text, p_open_access boolean, p_auto_screenshot boolean default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (is_operator() or is_project_owner(p_project)) then
    raise exception 'Only the project owner can change settings';
  end if;
  update projects
     set name = coalesce(nullif(trim(p_name), ''), name),
         site_url = coalesce(nullif(trim(p_site_url), ''), site_url),
         open_access = coalesce(p_open_access, open_access),
         auto_screenshot = coalesce(p_auto_screenshot, auto_screenshot)
   where id = p_project;
end $$;
revoke all on function update_project_settings(uuid, text, text, boolean, boolean) from public, anon;
grant execute on function update_project_settings(uuid, text, text, boolean, boolean) to authenticated;

-- Assignee options for the overlay/dashboard: owner + collaborators (owner/operator only).
create or replace function list_assignees(p_project uuid) returns jsonb
language plpgsql security definer stable set search_path = public as $$
begin
  if not (is_operator() or is_project_owner(p_project)) then raise exception 'Only the project owner can list assignees'; end if;
  return coalesce((
    select jsonb_agg(distinct e) from (
      select lower(u.email) as e from projects p join auth.users u on u.id = p.owner_id where p.id = p_project
      union select lower(m.email) from project_members m where m.project_id = p_project
    ) t), '[]'::jsonb);
end $$;
revoke all on function list_assignees(uuid) from public, anon;
grant execute on function list_assignees(uuid) to authenticated;
