-- v29: a design system draft sent in by an AI assistant (Claude Code via MCP
-- or the agent endpoint). It waits here until the owner previews it and
-- chooses "Use this design system" (design-rules draft_approve) or Discard.
alter table design_systems add column if not exists draft jsonb;
alter table design_systems add column if not exists draft_summary text;
alter table design_systems add column if not exists draft_by text;
alter table design_systems add column if not exists draft_at timestamptz;
notify pgrst, 'reload schema';
