// PinPoint — AI-assistant endpoint.
//
// Lets an AI coding assistant (Claude Code, Cursor, a CI script) close the
// loop on feedback: list what is open, reply to an item, mark it resolved.
// Authenticated by a per-project agent key (header x-pinpoint-agent-key),
// minted by the owner via get_agent_key() and included in owner exports.
//
//   GET  /agent?status=open|resolved|all[&page=/path]
//        -> { project: {name, site_url}, comments: [ {…, replies: […]} ] }
//   POST /agent  { comment_id, reply?, resolve?, reopen?, agent_name? }
//   POST /agent  { items: [ {comment_id, reply?, resolve?, reopen?} ], agent_name? }
//        -> { ok, results: [ {comment_id, status, reply_id?, error?} ] }
//
// Replies are stored with author_role = 'agent' and author_email
// 'agent:<project id>' so they are labelled "AI assistant" everywhere and
// never receive notifications themselves. Resolving is only ever explicit:
// the assistant must send resolve:true — a reply alone leaves the item open.
//
// Deploy: supabase functions deploy agent --no-verify-jwt --use-api

import { db, json } from "../_shared/db.ts";

const noStore = { "Cache-Control": "no-store" };
const KEY_RE = /^pp_[0-9a-f]{40}$/;
const SELECT = "id,project_id,parent_id,page_url,page_path,element_tag,selector,current_text,computed_styles,x_pct,y_pct,viewport_w,comment_text,author_name,author_role,status,created_at,attachments";

type Row = Record<string, any>;

async function resolveProject(req: Request) {
  const key = (req.headers.get("x-pinpoint-agent-key") ?? "").trim();
  if (!KEY_RE.test(key)) return null;
  const rows = await db<{ project_id: string }[]>(
    `project_secrets?agent_key=eq.${encodeURIComponent(key)}&select=project_id&limit=1`,
  );
  const pid = rows[0]?.project_id;
  if (!pid) return null;
  const p = await db<{ id: string; name: string; site_url: string; token: string }[]>(
    `projects?id=eq.${pid}&select=id,name,site_url,token&limit=1`,
  );
  return p[0] ?? null;
}

function shape(root: Row, all: Row[]) {
  const replies = all
    .filter((c) => c.parent_id === root.id)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
    .map((r) => ({ id: r.id, comment_text: r.comment_text, author_name: r.author_name, author_role: r.author_role, created_at: r.created_at }));
  const { project_id: _p, parent_id: _pp, ...rest } = root;
  return { ...rest, replies };
}

async function list(project: { id: string; name: string; site_url: string }, url: URL) {
  const status = url.searchParams.get("status") ?? "open";
  const page = url.searchParams.get("page");
  let q = `comments?project_id=eq.${project.id}&select=${SELECT}&order=created_at.asc&limit=2000`;
  if (page) q += `&page_path=eq.${encodeURIComponent(page)}`;
  const all = await db<Row[]>(q);
  const roots = all.filter((c) => !c.parent_id && (status === "all" || c.status === status));
  return json(200, { project: { name: project.name, site_url: project.site_url }, count: roots.length, comments: roots.map((r) => shape(r, all)) }, noStore);
}

async function act(project: { id: string }, item: Row, agentName: string) {
  const id = String(item.comment_id ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { comment_id: id, error: "bad comment_id" };
  const rows = await db<Row[]>(`comments?id=eq.${id}&project_id=eq.${project.id}&select=${SELECT}&limit=1`);
  let target = rows[0];
  if (!target) return { comment_id: id, error: "not found in this project" };
  if (target.parent_id) {
    const parent = await db<Row[]>(`comments?id=eq.${target.parent_id}&select=${SELECT}&limit=1`);
    if (parent[0]) target = parent[0];
  }
  const out: Row = { comment_id: target.id };

  const reply = (item.reply ?? "").toString().trim().slice(0, 4000);
  if (reply) {
    const inserted = await db<Row[]>("comments", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        project_id: project.id,
        parent_id: target.id,
        page_url: target.page_url,
        page_path: target.page_path,
        comment_text: reply,
        author_email: `agent:${project.id}`,
        author_name: agentName,
        author_role: "agent",
      }),
    });
    out.reply_id = inserted[0]?.id;
  }

  const wantResolve = item.resolve === true || item.resolve === "true";
  const wantReopen = item.reopen === true || item.reopen === "true";
  if (wantResolve || wantReopen) {
    const status = wantReopen ? "open" : "resolved";
    await db(`comments?id=eq.${target.id}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status }),
    });
    out.status = status;
  } else {
    out.status = target.status;
  }
  if (!reply && !wantResolve && !wantReopen) out.error = "nothing to do: send reply, resolve:true or reopen:true";
  return out;
}

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

  if (req.method === "GET") return list(project, url);

  let body: Row;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "bad JSON" }, noStore);
  }
  const agentName = (body.agent_name ?? "AI assistant").toString().trim().slice(0, 80) || "AI assistant";
  const items: Row[] = Array.isArray(body.items) ? body.items.slice(0, 50) : [body];
  const results = [];
  for (const item of items) {
    try {
      results.push(await act(project, item, agentName));
    } catch (e) {
      console.error("agent: item failed", e);
      results.push({ comment_id: item?.comment_id, error: "failed" });
    }
  }
  const ok = results.every((r) => !r.error);
  return json(ok ? 200 : 207, { ok, results }, noStore);
});
