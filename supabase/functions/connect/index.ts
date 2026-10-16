// PinPoint — "Sign in with PinPoint" for a site.
//
// The overlay's sign-in card opens the dashboard's #/connect page in a small
// window. There, the person (already signed in to the dashboard with their
// email code) confirms the site, and the page calls this function. It mints
// a NEW session for that person (separate from the dashboard's, so the two
// never fight over refresh tokens) and the page hands it to the site with
// postMessage, addressed to the site's exact origin.
//
// Safe for team accounts too, unlike the WordPress bridge: nothing happens
// without the person's own click in their own dashboard session, so a client
// admin can't trigger it by giving a WordPress user someone else's email.
//
// POST { action: "check" | "connect", token, origin }   (user JWT)
//   check   -> { project, host, allowed, email }      no session minted
//   connect -> { access_token, refresh_token, email } only if allowed
//
// The origin must be one of the project's addresses: its site URL, or an
// address where the project already has comments (local, staging,
// production). Callable from the dashboard origin only (CORS).
// Deploy: supabase functions deploy connect --no-verify-jwt --use-api

import { SUPABASE_URL, ANON_KEY, svcHeaders, db, json } from "../_shared/db.ts";
import { requireUser } from "../_shared/auth.ts";
import { corsHeaders, preflight } from "../_shared/cors.ts";

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$|\.(local|localhost|test)$/i;
const DASHBOARD = (Deno.env.get("DASHBOARD_URL") ?? "").split(",")[0].trim() || "https://pinpoint.avalanchegr.com/app/";

function cleanOrigin(raw: string): string | null {
  try {
    const u = new URL(String(raw || ""));
    if (u.origin !== String(raw).replace(/\/$/, "")) return null; // exactly an origin, nothing else
    if (u.protocol === "https:") return u.origin;
    if (u.protocol === "http:" && LOCAL.test(u.hostname)) return u.origin;
    return null;
  } catch {
    return null;
  }
}
const originOf = (url: string) => { try { return new URL(url).origin; } catch { return ""; } };

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  const h = { ...corsHeaders(req), "Cache-Control": "no-store" };
  if (req.method !== "POST") return json(405, { error: "POST only" }, h);
  const caller = await requireUser(req, h);
  if (caller instanceof Response) return caller;

  let b: any;
  try { b = await req.json(); } catch { return json(400, { error: "bad JSON" }, h); }
  const action = b.action === "connect" ? "connect" : "check";
  const origin = cleanOrigin(b.origin);
  if (!origin) return json(400, { error: "That site address isn't valid." }, h);
  const token = String(b.token || "").trim();
  if (!token || token.length > 200) return json(400, { error: "Missing project." }, h);

  const project = (await db<any[]>(`projects?token=eq.${encodeURIComponent(token)}&select=id,name,site_url&limit=1`))[0];
  if (!project) return json(404, { error: "That project doesn't exist." }, h);

  // Must be a real member of this project (owner, staff, collaborator).
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/my_project_role`, {
    method: "POST",
    headers: { apikey: ANON_KEY, Authorization: req.headers.get("authorization") || "", "Content-Type": "application/json" },
    body: JSON.stringify({ p_project: project.id }),
  });
  const role = r.ok ? (await r.json())?.role : null;
  if (!["owner", "operator", "collaborator"].includes(role)) return json(403, { error: "You're not a member of this project." }, h);

  // The site must be one of this project's addresses.
  let allowed = originOf(project.site_url) === origin;
  if (!allowed) {
    const hit = await db<any[]>(`comments?project_id=eq.${project.id}&page_url=like.${encodeURIComponent(origin + "/*")}&select=id&limit=1`);
    allowed = hit.length > 0;
  }
  const host = new URL(origin).host;
  if (action === "check") return json(200, { project: project.name, host, allowed, email: caller.email }, h);
  if (!allowed) return json(403, { error: `${host} isn't one of this project's addresses. Update the site URL in the project settings.` }, h);

  // A fresh session for this person (magic link, followed server-side).
  const gen = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: svcHeaders(),
    body: JSON.stringify({ type: "magiclink", email: caller.email, redirect_to: DASHBOARD }),
  });
  if (!gen.ok) { console.error("connect: generate_link", gen.status); return json(502, { error: "Couldn't sign you in. Try again." }, h); }
  const actionLink = (await gen.json()).action_link;
  const verify = actionLink ? await fetch(actionLink, { redirect: "manual" }) : null;
  const p = new URLSearchParams(((verify && verify.headers.get("location")) || "").split("#")[1] || "");
  const access_token = p.get("access_token"), refresh_token = p.get("refresh_token");
  if (!access_token || !refresh_token) { console.error("connect: no tokens"); return json(502, { error: "Couldn't sign you in. Try again." }, h); }
  return json(200, { access_token, refresh_token, email: caller.email }, h);
});
