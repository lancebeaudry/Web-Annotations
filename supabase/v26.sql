-- PinPoint 2.6 — daily roundup by default.
--
-- New-comment emails to a project's notify list used to go out on every
-- comment. Default is now one roundup a day per recipient (the `roundup`
-- edge function, pg_cron each morning). A project can switch back to
-- instant. @mention alerts and "needs your decision" emails stay instant
-- either way: they are addressed to one person.

alter table projects add column if not exists notify_mode text not null default 'daily';
alter table projects drop constraint if exists projects_notify_mode_check;
alter table projects add constraint projects_notify_mode_check check (notify_mode in ('daily', 'instant'));
alter table projects add column if not exists notify_last_roundup timestamptz;

create or replace function update_notify_mode(p_project uuid, p_mode text) returns text
language plpgsql security definer set search_path = public as $$
begin
  if not (is_operator() or is_project_owner(p_project)) then raise exception 'Only the project owner can change this'; end if;
  if p_mode not in ('daily', 'instant') then raise exception 'mode must be daily or instant'; end if;
  update projects set notify_mode = p_mode where id = p_project;
  return p_mode;
end $$;
revoke all on function update_notify_mode(uuid, text) from public, anon;
grant execute on function update_notify_mode(uuid, text) to authenticated;

-- my_project_role: same as v25 plus notify_mode.
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

-- Daily at 12:00 UTC (8am Eastern): the roundup function mails every
-- project on the daily setting that had comments since its last roundup.
do $$
declare v_url text; v_secret text; v_cmd text;
begin
  select value into v_url from private.app_settings where key = 'notify_url';
  select value into v_secret from private.app_settings where key = 'notify_secret';
  if v_url is null then return; end if;
  v_url := regexp_replace(v_url, '/notify$', '/roundup');
  v_cmd := format($c$select net.http_post(url := %L, headers := jsonb_build_object('Content-Type','application/json','x-notify-secret', %L), body := '{"all":true}'::jsonb)$c$, v_url, coalesce(v_secret, ''));
  perform cron.unschedule(jobid) from cron.job where jobname = 'pinpoint-roundup-daily';
  perform cron.schedule('pinpoint-roundup-daily', '0 12 * * *', v_cmd);
end $$;
notify pgrst, 'reload schema';
