-- PinPoint 2.4 — references from anywhere (the Chrome extension).
--
-- A "reference" is a comment captured on some other site: "I like this hero
-- for our homepage". It is a comments row (so threads, labels, effort,
-- export, Slack and the MCP tools all apply) with kind = 'reference' and a
-- source block: where it came from, a pixel screenshot of the element, its
-- text and the computed styles that matter. Until someone attaches it to
-- an element on the project's own site it has no page (page_path = '') and
-- is never pinned; attaching fills in page_path/selector like any comment.

alter table comments add column if not exists kind text not null default 'comment';
alter table comments drop constraint if exists comments_kind_check;
alter table comments add constraint comments_kind_check check (kind in ('comment', 'reference'));
alter table comments add column if not exists source jsonb;
create index if not exists comments_kind_idx on comments (project_id, kind) where kind <> 'comment';
notify pgrst, 'reload schema';
