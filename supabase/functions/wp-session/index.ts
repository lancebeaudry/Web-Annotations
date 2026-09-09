// Avalanche Markup — WordPress -> Supabase session bridge.
//
// Called server-side by the WP plugin's /session REST route ONLY for a
// user who is already logged into WordPress. Given that user's email, it
// mints a real Supabase session (access + refresh token) so the overlay
// runs with full RLS/realtime exactly as if they'd used email sign-in.
//
// Trust model (2.0): the caller proves it speaks for ONE site with that
// project's own bridge secret (x-avmk-project-secret; see _shared/bridge.ts).
// A session is minted only for the project's OWNER or an invited
// COLLABORATOR — never for an operator (staff sign in with the email code),
// and never for an arbitrary WP editor. A leaked secret is therefore scoped
// to its project and its already-invited people, and can be rotated.
//
// POST { email, name, token, redirect_to }  header: x-avmk-project-secret
// Deploy: supabase functions deploy wp-session --no-verify-jwt

import { SUPABASE_URL, svcHeaders, db, json } from "../_shared/db.ts";
import { resolveProjectBySecret } from "../_shared/bridge.ts";

const noStore = { "Cache-Control": "no-store" };

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" }, noStore);

  let email = "", name = "", token = "", redirectTo = SUPABASE_URL;
  try {
    const b = await req.json();
    email = (b.email || "").toLowerCase().trim();
    name = (b.name || "").toString().slice(0, 120);
    token = (b.token || "").toString().trim();
    if (b.redirect_to) redirectTo = b.redirect_to;
  } catch {
    return json(400, { error: "bad payload" }, noStore);
  }
  if (!email || !email.includes("@")) return json(400, { error: "bad email" }, noStore);

  const project = await resolveProjectBySecret(req, token);
  if (!project) return json(401, { error: "bad secret or unknown token" }, noStore);

  // Who is this email to this project? (SECURITY DEFINER SQL; service role.)
  const access = await db<string>(`rpc/bridge_user_access`, {
    method: "POST",
    body: JSON.stringify({ p_project: project.id, p_email: email }),
  });
  if (access === "operator") return json(403, { error: "operators sign in with their email code" }, noStore);
  if (access !== "owner" && access !== "collaborator") return json(403, { error: "not a collaborator on this project" }, noStore);

  // Ensure the auth user exists (idempotent — ignore "already registered").
  await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: svcHeaders(),
    body: JSON.stringify({ email, email_confirm: true, user_metadata: { name } }),
  }).catch(() => {});

  // Mint a real session: generate a magic link, then follow the verify
  // redirect server-side to pull the access/refresh tokens out of the
  // result hash (the same exchange a browser would do on click).
  const gen = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: svcHeaders(),
    body: JSON.stringify({ type: "magiclink", email, redirect_to: redirectTo }),
  });
  if (!gen.ok) return json(502, { error: "generate_link failed", detail: await gen.text() }, noStore);
  const actionLink = (await gen.json()).action_link;
  if (!actionLink) return json(502, { error: "no action link" }, noStore);

  const verify = await fetch(actionLink, { redirect: "manual" });
  const loc = verify.headers.get("location") || "";
  const hash = loc.split("#")[1] || "";
  const p = new URLSearchParams(hash);
  const access_token = p.get("access_token");
  const refresh_token = p.get("refresh_token");
  if (!access_token || !refresh_token) {
    return json(502, { error: "could not mint session", location: loc.slice(0, 200) }, noStore);
  }

  return json(200, { access_token, refresh_token, email, role: access }, noStore);
});
