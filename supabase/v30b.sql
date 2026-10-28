-- PinPoint 2.8.7 — the overlay asks the project whether it takes guest
-- feedback, instead of trusting the site's data-open flag.
--
-- Callable without a session (the sign-in card is drawn before anyone signs
-- in). Answers only true/false: an unknown token reads as false, so it
-- reveals nothing a closed project wouldn't.
create or replace function project_open_by_token(p_token text)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select open_access from projects where token = p_token), false);
$$;
revoke all on function project_open_by_token(text) from public;
grant execute on function project_open_by_token(text) to anon, authenticated;
notify pgrst, 'reload schema';
