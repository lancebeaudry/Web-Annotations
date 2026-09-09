// Avalanche Markup — project settings sync bridge.
//
// Lets the WordPress plugin push per-project settings (the "open feedback"
// toggle, and the site name) using only the site's own bridge secret
// (x-avmk-project-secret; see _shared/bridge.ts).
//
// POST { token, open_access?, name? }
// Deploy: supabase functions deploy project-settings --no-verify-jwt

import { db, json } from "../_shared/db.ts";
import { resolveProjectBySecret } from "../_shared/bridge.ts";

const noStore = { "Cache-Control": "no-store" };

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" }, noStore);

  let token = "", body: any = {};
  try {
    body = await req.json();
    token = (body.token || "").toString().trim();
  } catch {
    return json(400, { error: "bad payload" }, noStore);
  }
  if (!token) return json(400, { error: "missing token" }, noStore);

  const project = await resolveProjectBySecret(req, token);
  if (!project) return json(401, { error: "bad secret or unknown token" }, noStore);

  const patch: Record<string, unknown> = {};
  if ("open_access" in body) patch.open_access = body.open_access === true || body.open_access === "1";
  const name = (body.name ?? "").toString().trim().slice(0, 120);
  if (name) patch.name = name;
  if (!Object.keys(patch).length) return json(400, { error: "nothing to update" }, noStore);

  await db(`projects?id=eq.${project.id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });
  return json(200, patch, noStore);
});
