-- Avalanche Markup — image attachments on comments
-- Adds a Storage bucket for comment images + a column to reference them.

-- 1. Column: array of { url, name, type } on each comment.
alter table comments add column if not exists attachments jsonb not null default '[]'::jsonb;

-- 2. Public bucket for comment images (10 MB cap, images only). Public =
-- readable by URL so thumbnails render in the thread and exports; uploads
-- still require an auth policy below.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'comment-media', 'comment-media', true, 10485760,
  array['image/png','image/jpeg','image/gif','image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- 3. Policies on storage.objects for this bucket:
--    - any authenticated (comment-capable) user may upload
--    - anyone may read (bucket is public anyway)
drop policy if exists "comment-media auth upload" on storage.objects;
create policy "comment-media auth upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'comment-media');

drop policy if exists "comment-media public read" on storage.objects;
create policy "comment-media public read" on storage.objects
  for select
  using (bucket_id = 'comment-media');
