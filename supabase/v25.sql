-- PinPoint 2.5 — project managers.
--
-- A collaborator can be marked a manager of one project. A manager runs the
-- feedback on that project: resolve/reopen anything, assign, label, size,
-- delete any comment, reopen approved pages, send the digest. They do NOT
-- get the owner's controls: settings, invites, site secret, AI key,
-- integrations, billing, deleting the project.

alter table project_members add column if not exists manager boolean not null default false;

create or replace function is_project_manager(p_project uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(auth.jwt()->>'email','') <> ''
     and exists (select 1 from project_members pm
                  where pm.project_id = p_project
                    and lower(pm.email) = lower(auth.jwt()->>'email')
                    and pm.manager);
$$;

-- Owner/operator flips the flag on an existing collaborator.
create or replace function set_member_manager(p_project uuid, p_email text, p_manager boolean) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not (is_operator() or is_project_owner(p_project)) then raise exception 'Only the project owner can change this'; end if;
  update project_members set manager = coalesce(p_manager, false)
   where project_id = p_project and lower(email) = lower(trim(p_email));
  if not found then raise exception 'Invite this person as a collaborator first'; end if;
  return coalesce(p_manager, false);
end $$;

-- comments: managers may update and delete any comment on their project.
alter policy "update comments" on comments
  using (project_is_writable(project_id) and (
    is_operator() or is_project_owner(project_id) or is_project_manager(project_id)
    or lower(author_email) = lower(coalesce(auth.email(), ''))
    or author_email = ('guest:' || (auth.uid())::text)
    or lower(coalesce(assignee_email, '')) = lower(coalesce(auth.email(), ''))))
  with check (project_is_writable(project_id));
alter policy "delete own or manager" on comments
  using (is_operator() or is_project_owner(project_id) or is_project_manager(project_id)
    or author_email = (auth.jwt() ->> 'email')
    or author_email = ('guest:' || (auth.uid())::text));

-- assignee list: managers assign too.
create or replace function list_assignees(p_project uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not (is_operator() or is_project_owner(p_project) or is_project_manager(p_project)) then raise exception 'Only the project owner or a manager can list assignees'; end if;
  return coalesce((
    select jsonb_agg(distinct e) from (
      select lower(u.email) as e from projects p join auth.users u on u.id = p.owner_id where p.id = p_project
      union select lower(m.email) from project_members m where m.project_id = p_project
    ) t), '[]'::jsonb);
end $$;

-- approvals: a manager can reopen any approved page.
create or replace function revoke_approval(p_project uuid, p_page text) returns void
language plpgsql security definer set search_path = public as $$
declare r text; v_email text;
begin
  if auth.uid() is null or is_anonymous_session() then raise exception 'Sign in first'; end if;
  r := my_project_role(p_project)->>'role';
  select lower(email) into v_email from auth.users where id = auth.uid();
  update page_approvals set revoked_at = now(), revoked_by_email = v_email
   where project_id = p_project and page_path = p_page and revoked_at is null
     and (r in ('operator','owner') or is_project_manager(p_project) or approved_by_email = v_email);
  if not found then raise exception 'Nothing to reopen, or not allowed'; end if;
end $$;

-- role payload: same as v231 plus `manager`.
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
    'manager', r = 'collaborator' and is_project_manager(p_project),
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

revoke all on function is_project_manager(uuid), set_member_manager(uuid, text, boolean) from public, anon;
grant execute on function is_project_manager(uuid), set_member_manager(uuid, text, boolean) to authenticated;
notify pgrst, 'reload schema';
