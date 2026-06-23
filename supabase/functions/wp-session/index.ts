// Avalanche Markup — WordPress -> Supabase session bridge.
//
// Called server-side by the WP plugin's /session REST route ONLY for a
// user who is already logged into WordPress. Given that user's email, it
// mints a real Supabase session (access + refresh token) so the overlay
// can run with full RLS/realtime exactly as if they'd used email sign-in.
//
// Trust model: the caller proves it's our plugin with a shared secret
// (WP_AUTH_SECRET). The plugin only ever sends the *currently logged-in*
// WP user's email. Team-domain emails are refused outright — a compromised
// client WP server must never be able to mint a team session (those carry
// export/delete powers). Worst case is a client-level session.
//
// Secrets: WP_AUTH_SECRET (shared with the plugin), TEAM_DOMAIN (optional).
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WP_AUTH_SECRET = Deno.env.get("WP_AUTH_SECRET") ?? "";
const TEAM_DOMAIN = (Deno.env.get("TEAM_DOMAIN") ?? "avalanchegr.com").toLowerCase();

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const svc = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  if (!WP_AUTH_SECRET || req.headers.get("x-wp-auth-secret") !== WP_AUTH_SECRET) {
    return json(401, { error: "bad secret" });
  }

  let email = "", name = "", token = "", redirectTo = SUPABASE_URL;
  try {
    const b = await req.json();
    email = (b.email || "").toLowerCase().trim();
    name = (b.name || "").toString().slice(0, 120);
    token = (b.token || "").toString().trim();
    if (b.redirect_to) redirectTo = b.redirect_to;
  } catch {
    return json(400, { error: "bad payload" });
  }
  if (!email || !email.includes("@")) return json(400, { error: "bad email" });
  if (email.endsWith(`@${TEAM_DOMAIN}`)) {
    return json(403, { error: "team accounts must use email sign-in" });
  }

  // Resolve the site's project from its token — a WP user is granted
  // access to THAT project only, not everything.
  const projects = await fetch(
    `${SUPABASE_URL}/rest/v1/projects?token=eq.${encodeURIComponent(token)}&select=id`,
    { headers: svc },
  ).then((r) => r.json()).catch(() => []);
  const projectId = projects?.[0]?.id;
  if (!projectId) return json(400, { error: "unknown project token" });

  // Ensure the auth user exists (idempotent — ignore "already registered").
  await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: svc,
    body: JSON.stringify({ email, email_confirm: true, user_metadata: { name } }),
  }).catch(() => {});

  // Grant membership to this project (and only this project).
  await fetch(`${SUPABASE_URL}/rest/v1/project_members`, {
    method: "POST",
    headers: { ...svc, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ project_id: projectId, email, note: "WordPress user" }),
  }).catch(() => {});

  // Mint a real session: generate a magic link, then follow the verify
  // redirect server-side to pull the access/refresh tokens out of the
  // result hash (the same exchange a browser would do on click).
  const gen = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: svc,
    body: JSON.stringify({ type: "magiclink", email, redirect_to: redirectTo }),
  });
  if (!gen.ok) return json(502, { error: "generate_link failed", detail: await gen.text() });
  const actionLink = (await gen.json()).action_link;
  if (!actionLink) return json(502, { error: "no action link" });

  const verify = await fetch(actionLink, { redirect: "manual" });
  const loc = verify.headers.get("location") || "";
  const hash = loc.split("#")[1] || "";
  const p = new URLSearchParams(hash);
  const access_token = p.get("access_token");
  const refresh_token = p.get("refresh_token");
  if (!access_token || !refresh_token) {
    return json(502, { error: "could not mint session", location: loc.slice(0, 200) });
  }

  return json(200, { access_token, refresh_token, email });
});
