// PinPoint — validate an integration before the dashboard saves it.
//
// POST { project_id, kind: "slack" | "clickup", config }  (user JWT)
//   slack   -> posts a hello message to the webhook
//   clickup -> reads the list; returns its name and statuses
// The caller must own the project (or be an operator) and be on a plan with
// integrations. Nothing is stored here; the dashboard calls the
// set_integration RPC afterwards.
// Deploy: supabase functions deploy integration-test --no-verify-jwt --use-api

import { db, json } from "../_shared/db.ts";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { requireUser } from "../_shared/auth.ts";
import { testSlack, testClickUp } from "../_shared/integrations.ts";

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  const cors = corsHeaders(req);
  if (req.method !== "POST") return json(405, { error: "POST only" }, cors);
  const caller = await requireUser(req, cors);
  if (caller instanceof Response) return caller;

  let body: any;
  try { body = await req.json(); } catch { return json(400, { error: "bad JSON" }, cors); }
  const pid = String(body.project_id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(pid)) return json(400, { error: "project_id required" }, cors);

  const projects = await db<any[]>(`projects?id=eq.${pid}&select=id,name,owner_id&limit=1`);
  const project = projects[0];
  if (!project) return json(404, { error: "project not found" }, cors);
  const ops = await db<any[]>(`operators?user_id=eq.${caller.id}&select=user_id&limit=1`);
  if (project.owner_id !== caller.id && !ops.length) return json(403, { error: "not the project owner" }, cors);
  const feat = await db<any[]>(`rpc/plan_has`, { method: "POST", body: JSON.stringify({ p_user: project.owner_id, p_feature: "integrations" }) });
  if (feat !== true && !ops.length) return json(402, { error: "PLAN_FEATURE_REQUIRED", hint: "Integrations are part of the Agency plan." }, cors);

  try {
    if (body.kind === "slack") {
      const url = String(body.config?.webhook_url ?? "");
      if (!/^https:\/\/hooks\.slack\.com\/services\//.test(url)) return json(400, { error: "That doesn't look like a Slack incoming-webhook URL." }, cors);
      await testSlack(url, project.name);
      return json(200, { ok: true }, cors);
    }
    if (body.kind === "clickup") {
      const token = String(body.config?.token ?? ""), listId = String(body.config?.list_id ?? "").trim();
      if (!token || !listId) return json(400, { error: "ClickUp token and list ID are required." }, cors);
      const info = await testClickUp(token, listId);
      return json(200, { ok: true, ...info }, cors);
    }
    return json(400, { error: "kind must be slack or clickup" }, cors);
  } catch (e) {
    return json(400, { error: (e as Error).message.slice(0, 200) }, cors);
  }
});
