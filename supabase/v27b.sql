-- Owner's email for a project (service role only; used by design-rules to
-- pick the default approver).
create or replace function project_owner_email(p_project uuid) returns text
language sql stable security definer set search_path = public as $$
  select lower(u.email) from projects p join auth.users u on u.id = p.owner_id where p.id = p_project;
$$;
revoke all on function project_owner_email(uuid) from public, anon, authenticated;
notify pgrst, 'reload schema';
