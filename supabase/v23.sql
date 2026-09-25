-- PinPoint 2.3 — triage: "Waiting on client" status, labels, effort, digest.
--
-- What Nick was doing by hand in chat (sorting items into "we own it" vs
-- "client decides" vs "quick" vs "needs a build") now lives on the item:
--   status   waiting            → the client has to decide or supply something
--   labels   bug copy design content photo decision   (any combination)
--   effort   quick | medium | large
-- The digest edge function emails a project's collaborators the items that
-- are waiting on them; projects can opt into a weekly send.

-- 1. status: add 'waiting'
alter table comments drop constraint if exists comments_status_check;
alter table comments add constraint comments_status_check
  check (status in ('open','in_progress','waiting','resolved','wont_fix'));

-- 2. labels + effort
alter table comments add column if not exists labels text[] not null default '{}';
alter table comments add column if not exists effort text;
alter table comments drop constraint if exists comments_labels_check;
alter table comments add constraint comments_labels_check
  check (labels <@ array['bug','copy','design','content','photo','decision']::text[]);
alter table comments drop constraint if exists comments_effort_check;
alter table comments add constraint comments_effort_check
  check (effort is null or effort in ('quick','medium','large'));
create index if not exists comments_labels_idx on comments using gin (labels);

-- 3. digest settings
alter table projects add column if not exists digest_weekly boolean not null default false;
alter table projects add column if not exists digest_last_sent timestamptz;

create or replace function update_digest_settings(p_project uuid, p_weekly boolean) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not (is_operator() or is_project_owner(p_project)) then raise exception 'Only the project owner can change this'; end if;
  update projects set digest_weekly = coalesce(p_weekly, false) where id = p_project;
  return coalesce(p_weekly, false);
end $$;
revoke all on function update_digest_settings(uuid, boolean) from public, anon;
grant execute on function update_digest_settings(uuid, boolean) to authenticated;

-- Expose the flag to the dashboard through my_project_role (same shape as
-- v22b, plus digest_weekly).
create or replace function my_project_role(p_project uuid) returns jsonb
language plpgsql security definer stable set search_path = public as $$
declare r text; v_owner uuid; v_plan text; pl plans; v_auto boolean; v_weekly boolean;
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
  select owner_id, auto_screenshot, digest_weekly into v_owner, v_auto, v_weekly from projects where id = p_project;
  v_plan := plan_of(v_owner);
  select * into pl from plans where id = v_plan;
  return jsonb_build_object(
    'role', r,
    'writable', r <> 'none' and project_is_writable(p_project),
    'plan', v_plan,
    'auto_screenshot', coalesce(v_auto, true),
    'digest_weekly', coalesce(v_weekly, false),
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

-- 4. weekly digest: pg_cron calls the digest function every Monday 13:00 UTC
--    (9am Eastern) with the notify secret; the function picks projects that
--    opted in and have waiting items.
do $$
declare v_url text; v_secret text; v_cmd text;
begin
  select value into v_url from private.app_settings where key = 'notify_url';
  select value into v_secret from private.app_settings where key = 'notify_secret';
  if v_url is null then return; end if;
  v_url := regexp_replace(v_url, '/notify$', '/digest');
  v_cmd := format($c$select net.http_post(url := %L, headers := jsonb_build_object('Content-Type','application/json','x-notify-secret', %L), body := '{"all":true}'::jsonb)$c$, v_url, coalesce(v_secret, ''));
  perform cron.unschedule(jobid) from cron.job where jobname = 'pinpoint-digest-weekly';
  perform cron.schedule('pinpoint-digest-weekly', '0 13 * * 1', v_cmd);
end $$;
