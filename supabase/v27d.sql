-- v27d: remember where an imported design system came from (a style guide
-- page or tokens file), so the owner can re-import it in one click.
alter table design_systems add column if not exists source_url text;
notify pgrst, 'reload schema';
