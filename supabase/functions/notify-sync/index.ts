// Avalanche Markup — notify-list sync bridge.
//
// Lets the WordPress plugin's "Email notifications" field sync to the
// backend WITHOUT any key on the WP server beyond the site's own bridge
// secret (x-avmk-project-secret; see _shared/bridge.ts). Replaces the
// project's notify_recipients wholesale.
//
// POST { token, emails: string[] }
// Deploy: supabase functions deploy notify-sync --no-verify-jwt

import { db, json } from "../_shared/db.ts";
import { resolveProjectBySecret } from "../_shared/bridge.ts";

const noStore = { "Cache-Control": "no-store" };

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" }, noStore);

  let token = "", emails: string[] = [];
  try {
    const b = await req.json();
    token = (b.token || "").toString().trim();
    emails = Array.isArray(b.emails) ? b.emails : [];
  } catch {
    return json(400, { error: "bad payload" }, noStore);
  }
  if (!token) return json(400, { error: "missing token" }, noStore);

  const project = await resolveProjectBySecret(req, token);
  if (!project) return json(401, { error: "bad secret or unknown token" }, noStore);

  const list = [...new Set(
    emails.map((e) => (e || "").toString().toLowerCase().trim()).filter((e) => e.includes("@")),
  )];

  await db(`notify_recipients?project_id=eq.${project.id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  if (list.length) {
    await db(`notify_recipients`, {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(list.map((email) => ({ project_id: project.id, email }))),
    });
  }
  return json(200, { synced: list.length }, noStore);
});
