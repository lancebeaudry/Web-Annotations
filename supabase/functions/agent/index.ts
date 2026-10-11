// PinPoint — AI-assistant endpoint (curl-shaped). See _shared/feedback.ts.
//
//   GET  /agent?status=open|in_progress|waiting|resolved|wont_fix|all[&page=/path][&label=bug]
//   GET  /agent?pages=1                       -> pages with open counts
//   GET  /agent?design=1                      -> design system + how to use it (when design rules are on)
//   POST /agent  { design_check: { element, property, value, page_path?, selector?, context? } }
//   POST /agent  { comment_id, reply?, status?, resolve?, reopen?, assignee?, labels?, effort?, agent_name? }
//   POST /agent  { items: [ … ], agent_name? }
// Auth: x-pinpoint-agent-key (or Authorization: Bearer pp_…). The same key
// works with the MCP server at /mcp for assistants that speak MCP.
// Deploy: supabase functions deploy agent --no-verify-jwt --use-api

import { json } from "../_shared/db.ts";
import { resolveProject, listFeedback, listPages, actOn, designFor, DESIGN_GUIDE } from "../_shared/feedback.ts";
import { check as designCheck } from "../_shared/designEngine.ts";

const noStore = { "Cache-Control": "no-store" };

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method !== "GET" && req.method !== "POST") return json(405, { error: "GET or POST" }, noStore);

  let project;
  try {
    project = await resolveProject(req);
  } catch (e) {
    console.error("agent: lookup failed", e);
    return json(500, { error: "lookup failed" }, noStore);
  }
  if (!project) return json(401, { error: "missing or unknown x-pinpoint-agent-key" }, noStore);

  if (req.method === "GET") {
    if (url.searchParams.get("pages")) return json(200, { pages: await listPages(project) }, noStore);
    if (url.searchParams.get("design")) {
      const ds = await designFor(project);
      return ds ? json(200, { guide: DESIGN_GUIDE, version: ds.version, tokens: ds.tokens }, noStore) : json(404, { error: "Design rules aren't switched on for this project." }, noStore);
    }
    return json(200, await listFeedback(project, { status: url.searchParams.get("status") ?? "open", page: url.searchParams.get("page") ?? undefined, label: url.searchParams.get("label") ?? undefined }), noStore);
  }

  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "bad JSON" }, noStore);
  }
  if (body.design_check && typeof body.design_check === "object") {
    const ds = await designFor(project);
    if (!ds) return json(404, { error: "Design rules aren't switched on for this project." }, noStore);
    const a = body.design_check, ctx = a.context && typeof a.context === "object" ? a.context : {};
    return json(200, designCheck(ds.tokens, {
      element: String(a.element || ""), property: String(a.property || ""), value: String(a.value || "").slice(0, 100),
      context: { surface: ctx.surface, button: ctx.button, background: ctx.background, text: ctx.text, current: ctx.current },
      target: { page_path: String(a.page_path || ""), selector: String(a.selector || "").slice(0, 300) },
      viewport_w: Number(a.viewport_w) || undefined,
    } as any), noStore);
  }
  const agentName = (body.agent_name ?? "AI assistant").toString().trim().slice(0, 80) || "AI assistant";
  const items = Array.isArray(body.items) ? body.items.slice(0, 50) : [body];
  const results = [];
  for (const item of items) {
    try {
      results.push(await actOn(project, item, agentName));
    } catch (e) {
      console.error("agent: item failed", e);
      results.push({ comment_id: item?.comment_id, error: "failed" });
    }
  }
  const ok = results.every((r) => !r.error);
  return json(ok ? 200 : 207, { ok, results }, noStore);
});
