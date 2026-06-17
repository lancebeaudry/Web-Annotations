-- Avalanche Markup — @mentions + new-comment notifications
-- Incremental migration. Safe to run on an existing database as-is
-- (everything is IF NOT EXISTS / CREATE OR REPLACE). The same objects
-- are mirrored into schema.sql so fresh installs get them too.
--
-- Pipeline: a comment INSERT fires an AFTER trigger that POSTs the row
-- to the `notify` Edge Function (Gmail SMTP sender). The function works
-- out who to email — people @mentioned in the comment, plus the team's
-- per-project notify list — and sends. See supabase/functions/notify.

-- pg_net: lets a Postgres trigger make an outbound HTTP call (to the
-- Edge Function). Ships with Supabase; just needs enabling.
create extension if not exists pg_net with schema extensions;

-- --------------------------------------------------------------------
-- 1. Mentions: which signed-in users were @tagged in a given comment.
--    Stored as an array of lower-cased emails on the comment row.
-- --------------------------------------------------------------------
alter table comments add column if not exists mentions text[] not null default '{}';

-- --------------------------------------------------------------------
-- 2. Team notify list: who gets emailed when a client leaves a comment,
--    per project. Managed from the WordPress plugin settings page and
--    pushed here on save with the service-role key (same pattern as the
--    token sync). No client ever reads or writes this table — RLS is on
--    with zero policies, so anon/authenticated are denied; only the
--    service role (plugin sync) and the Edge Function (service role)
--    touch it.
-- --------------------------------------------------------------------
create table if not exists notify_recipients (
  project_id uuid not null references projects(id) on delete cascade,
  email      text not null,
  created_at timestamptz default now(),
  primary key (project_id, email)
);
alter table notify_recipients enable row level security;

-- --------------------------------------------------------------------
-- 3. Mentionable roster for the @ autocomplete. Deliberately project-
--    scoped so one client can never enumerate another's emails: it
--    returns only people who have already participated on THIS project
--    plus the project's configured notify recipients (your team). The
--    caller must be allowed on the project (team domain or invited).
-- --------------------------------------------------------------------
create or replace function public.list_mentionable(p_project uuid)
returns table(email text, name text)
language plpgsql security definer set search_path = public as $fn$
declare caller text := lower(coalesce(auth.jwt()->>'email',''));
begin
  if caller = '' then
    raise exception 'Not signed in';
  end if;
  -- Same gate as the comment-read policy: team domain or invited.
  if caller not like '%@avalanchegr.com'
     and not exists (select 1 from allowed_emails ae where lower(ae.email) = caller) then
    raise exception 'Not allowed';
  end if;

  return query
    with people as (
      select lower(c.author_email) as email,
             max(c.author_name) filter (where c.author_name is not null) as name
        from comments c
       where c.project_id = p_project
       group by lower(c.author_email)
      union
      select lower(nr.email) as email, null::text as name
        from notify_recipients nr
       where nr.project_id = p_project
    )
    select p.email, p.name
      from people p
     where p.email <> caller          -- don't suggest mentioning yourself
     order by p.name nulls last, p.email;
end; $fn$;
revoke all on function public.list_mentionable(uuid) from public, anon;
grant execute on function public.list_mentionable(uuid) to authenticated;

-- --------------------------------------------------------------------
-- 4. Outbound webhook config. Kept in a `private` schema that PostgREST
--    does not expose, so the Edge Function URL and shared secret are
--    invisible to anon/authenticated clients. Populated at activation:
--      insert into private.app_settings(key,value) values
--        ('notify_url','https://<ref>.supabase.co/functions/v1/notify'),
--        ('notify_secret','<random-shared-secret>')
--      on conflict (key) do update set value = excluded.value;
-- --------------------------------------------------------------------
create schema if not exists private;
create table if not exists private.app_settings (
  key   text primary key,
  value text not null
);

-- --------------------------------------------------------------------
-- 5. Trigger: on every new comment, POST the row to the Edge Function.
--    Fire-and-forget (pg_net is async) so a slow/unreachable mailer
--    never blocks or fails the client's insert. The function decides
--    recipients and whether to send at all.
-- --------------------------------------------------------------------
create or replace function public.notify_on_comment()
returns trigger language plpgsql security definer
set search_path = public, extensions as $fn$
declare
  v_url    text;
  v_secret text;
begin
  select value into v_url    from private.app_settings where key = 'notify_url';
  select value into v_secret from private.app_settings where key = 'notify_secret';
  if v_url is null then
    return new; -- not configured yet; do nothing
  end if;

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
                 'Content-Type',   'application/json',
                 'x-notify-secret', coalesce(v_secret, '')
               ),
    body    := jsonb_build_object('record', row_to_json(new)::jsonb)
  );
  return new;
end; $fn$;

drop trigger if exists comments_notify on comments;
create trigger comments_notify
  after insert on comments
  for each row execute function public.notify_on_comment();
