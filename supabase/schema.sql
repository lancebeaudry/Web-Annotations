-- Avalanche Markup — Supabase schema + RLS
-- Run this whole file in the Supabase SQL editor (Database -> SQL Editor).

-- PROJECTS: one row per client site
create table projects (
  id          uuid primary key default gen_random_uuid(),
  token       text unique not null,          -- the value passed in ?markup=TOKEN
  name        text not null,                 -- e.g. "Eastbrook Homes"
  site_url    text not null,
  created_at  timestamptz default now()
);

-- COMMENTS: pins + threaded replies (parent_id null = top-level pin)
create table comments (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references projects(id) on delete cascade,
  parent_id     uuid references comments(id) on delete cascade,

  page_url      text not null,               -- normalized, query-string stripped
  page_path     text not null,               -- for grouping in export

  -- auto-captured context (null for replies)
  selector          text,                    -- best-effort unique CSS selector
  selector_fallback jsonb,                   -- {tag, text, nearbyLandmark} for re-resolution
  element_tag       text,
  current_text      text,
  computed_styles   jsonb,                   -- {fontSize, color, fontWeight, ...} subset

  -- pin position (% of the captured element's box)
  x_pct         numeric,
  y_pct         numeric,
  viewport_w    integer,                     -- width when pin was placed

  comment_text  text not null,               -- what the client typed
  author_email  text not null,
  author_name   text,
  status        text not null default 'open',-- 'open' | 'resolved'

  created_at    timestamptz default now()
);

create index comments_project_idx on comments(project_id);
create index comments_page_idx on comments(project_id, page_path);
create index comments_thread_idx on comments(parent_id);

-- ---------------------------------------------------------------
-- Row-Level Security
-- The anon key ships in the public snippet, so RLS is the actual
-- security boundary. v1 model: any authed user may read/write
-- comments; project rows are only fetched by token (no list UI).
-- Known v1 tradeoff: upgrade to a project_members table when
-- cross-client isolation starts to matter.
-- ---------------------------------------------------------------

alter table projects enable row level security;
alter table comments enable row level security;

-- ALLOWED_EMAILS: the invite list. Anyone on the Avalanche team domain
-- is implicitly allowed; everyone else must be added here to use the
-- tool at all. Rows are added by admin/invite.mjs (service-role key).
create table allowed_emails (
  email       text primary key,
  note        text,
  created_at  timestamptz default now()
);
alter table allowed_emails enable row level security;

-- A signed-in user may check whether their own email is on the list
-- (the snippet queries: select ... where email = me). No list access.
create policy "read own allow" on allowed_emails
  for select using (lower(email) = lower(auth.jwt()->>'email'));

-- Helper condition: team domain OR explicitly invited.
-- (Inlined into each comment policy below.)

-- Projects: an authed user can read a project only by knowing its token
-- (snippet queries: select ... where token = $1). No blanket list access.
create policy "read project by token" on projects
  for select using (auth.role() = 'authenticated');

-- Comments: only team or invited emails can read/insert; updates and
-- deletes limited to own rows or team.
create policy "read comments" on comments
  for select using (
    (auth.jwt()->>'email') like '%@avalanchegr.com'
    or exists (
      select 1 from allowed_emails ae
      where lower(ae.email) = lower(auth.jwt()->>'email')
    )
  );

create policy "insert comments" on comments
  for insert with check (
    author_email = auth.jwt()->>'email'
    and (
      (auth.jwt()->>'email') like '%@avalanchegr.com'
      or exists (
        select 1 from allowed_emails ae
        where lower(ae.email) = lower(auth.jwt()->>'email')
      )
    )
  );

create policy "update own or team" on comments
  for update using (
    author_email = auth.jwt()->>'email'
    or (auth.jwt()->>'email') like '%@avalanchegr.com'
  );

create policy "delete own or team" on comments
  for delete using (
    author_email = auth.jwt()->>'email'
    or (auth.jwt()->>'email') like '%@avalanchegr.com'
  );

-- Realtime: broadcast comment inserts/updates to subscribed clients
alter publication supabase_realtime add table comments;

-- ---------------------------------------------------------------
-- Seed a test project (edit name/url, keep the token handy —
-- it's what goes in ?markup=TOKEN and data-project="TOKEN")
-- ---------------------------------------------------------------
insert into projects (token, name, site_url)
values ('test-token', 'Local Test Site', 'http://localhost:8123');
