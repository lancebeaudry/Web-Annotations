-- Avalanche Markup — distribution bucket
--
-- The public Storage bucket `markup` is the single distribution point for
-- everything that is served to browsers and to WordPress sites:
--   markup.js                        overlay bundle for non-WordPress embeds
--   markup-<version>.js              immutable per-release copy (rollback)
--   plugin/update.json               update manifest polled by every WP site
--   plugin/avalanche-markup-<v>.zip  immutable per-release plugin package
--   plugin/avalanche-markup.zip      versionless alias for manual uploads
--   app/*                            the customer dashboard
--
-- Why Storage and not raw GitHub: raw.githubusercontent.com serves JS as
-- text/plain + nosniff (browsers refuse to execute it), and the repo is
-- going private, which would 404 the updater on every site.
--
-- The bucket was originally created out-of-band via the Storage API; this
-- file makes it reproducible. Cache-Control is set per object at upload
-- time by admin/release.mjs (versionless keys: 60s — there is NO CDN purge;
-- versioned keys: immutable).
--
-- WRITES ARE SERVICE-ROLE ONLY. There is deliberately no insert/update/
-- delete policy for anon or authenticated: with the anon key public, any
-- such policy would let a stranger overwrite markup.js on every customer
-- site. Uploads come only from the release/deploy scripts using the
-- service-role key from .env.

insert into storage.buckets (id, name, public)
values ('markup', 'markup', true)
on conflict (id) do update set public = true;

-- Public read. Public buckets serve /object/public/* without RLS, but the
-- SELECT policy keeps parity with comment-media (attachments.sql) and lets
-- the client API list objects if that is ever needed.
drop policy if exists "markup public read" on storage.objects;
create policy "markup public read" on storage.objects
  for select using (bucket_id = 'markup');
