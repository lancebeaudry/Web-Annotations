-- PinPoint Setup — leads from the fit questionnaire on /setup/.
-- Written only by the setup-intake edge function (service role). RLS is on
-- with no policies, so no browser session can read or write it; operators
-- read it through the RPC below.

create table if not exists setup_leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null,
  email text not null,
  site text not null,
  answers jsonb not null default '{}'::jsonb,
  result text not null,
  ip_hash text,
  user_agent text,
  handled boolean not null default false
);
create index if not exists setup_leads_created_idx on setup_leads (created_at desc);
create index if not exists setup_leads_ip_idx on setup_leads (ip_hash, created_at);
alter table setup_leads enable row level security;

create or replace function list_setup_leads() returns setof setup_leads
language plpgsql security definer set search_path = public as $$
begin
  if not is_operator() then raise exception 'Operators only'; end if;
  return query select * from setup_leads order by created_at desc limit 200;
end $$;
revoke all on function list_setup_leads() from public, anon;
grant execute on function list_setup_leads() to authenticated;
notify pgrst, 'reload schema';
