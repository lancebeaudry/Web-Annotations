-- Avalanche Markup — team self-registration of new sites
--
-- Problem this solves: a project only works once a row exists in `projects`
-- for its token. New sites (fresh Local installs, staging, production) don't
-- carry the service-role key, so nothing auto-created that row — every new
-- site threw "unknown project token" until it was registered by hand.
--
-- Fix: let a signed-in Avalanche team member (an @avalanchegr.com JWT) INSERT
-- a project. The overlay then self-registers a site the first time a team
-- member opens its markup link (see registerProject() in src/app.js). No
-- service key on the site, no shared secret — just this policy plus the anon
-- key the bundle already ships with. The unique index on projects.token makes
-- concurrent first-visits safe: the loser hits a unique violation and re-reads
-- the row the winner just created.
--
-- Guests / clients (no team email) still can't create projects, so a brand-new
-- open-feedback site needs one team visit before name-only guests can use it.

drop policy if exists "team creates projects" on projects;
create policy "team creates projects" on projects
  for insert with check (
    (auth.jwt()->>'email') like '%@avalanchegr.com'
  );
