// Feedback operations shared by the `agent` endpoint (curl-shaped) and the
// `mcp` server (tool-shaped). Both authenticate with a per-project agent key.

import { db } from "./db.ts";

export type Row = Record<string, any>;
export type Project = { id: string; name: string; site_url: string; token: string };

export const STATUSES = ["open", "in_progress", "resolved", "wont_fix"] as const;
export type Status = typeof STATUSES[number];
const KEY_RE = /^pp_[0-9a-f]{40}$/;
export const SELECT = "id,project_id,parent_id,page_url,page_path,element_tag,selector,current_text,computed_styles,x_pct,y_pct,viewport_w,comment_text,author_name,author_role,status,assignee_email,created_at,attachments,context";

// Key from x-pinpoint-agent-key or Authorization: Bearer pp_…
export function keyFrom(req: Request): string {
  const h = (req.headers.get("x-pinpoint-agent-key") ?? "").trim();
  if (h) return h;
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(pp_[0-9a-f]{40})$/i);
  return m ? m[1] : "";
}

export async function resolveProject(req: Request): Promise<Project | null> {
  const key = keyFrom(req);
  if (!KEY_RE.test(key)) return null;
  const rows = await db<{ project_id: string }[]>(`project_secrets?agent_key=eq.${encodeURIComponent(key)}&select=project_id&limit=1`);
  const pid = rows[0]?.project_id;
  if (!pid) return null;
  const p = await db<Project[]>(`projects?id=eq.${pid}&select=id,name,site_url,token&limit=1`);
  return p[0] ?? null;
}

// Who a reply written through the agent key is signed as. Projects default
// to the owner; they can name a collaborator or opt in to the AI label.
export type Persona = { label: boolean; email: string; name: string | null; role: string };
export async function agentPersona(project: Project): Promise<Persona> {
  try {
    const r = await db<Persona>("rpc/agent_persona", { method: "POST", body: JSON.stringify({ p_project: project.id }) });
    if (r && r.email) return r;
  } catch (_) { /* fall through */ }
  return { label: true, email: `agent:${project.id}`, name: null, role: "agent" };
}

export function shape(root: Row, all: Row[]) {
  const replies = all
    .filter((c) => c.parent_id === root.id)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
    .map((r) => ({ id: r.id, comment_text: r.comment_text, author_name: r.author_name, author_role: r.author_role, created_at: r.created_at }));
  const { project_id: _p, parent_id: _pp, ...rest } = root;
  return { ...rest, replies };
}

export async function listFeedback(project: Project, opts: { status?: string; page?: string } = {}) {
  const status = opts.status ?? "open";
  let q = `comments?project_id=eq.${project.id}&select=${SELECT}&order=created_at.asc&limit=2000`;
  if (opts.page) q += `&page_path=eq.${encodeURIComponent(opts.page)}`;
  const all = await db<Row[]>(q);
  const wanted = (s: string) => status === "all" || (status === "open" ? s === "open" || s === "in_progress" : s === status);
  const roots = all.filter((c) => !c.parent_id && wanted(c.status));
  return { project: { name: project.name, site_url: project.site_url }, count: roots.length, comments: roots.map((r) => shape(r, all)) };
}

export async function listPages(project: Project) {
  const all = await db<Row[]>(`comments?project_id=eq.${project.id}&parent_id=is.null&select=page_path,page_url,status`);
  const pages = new Map<string, { page_path: string; page_url: string; open: number; total: number }>();
  for (const c of all) {
    const p = pages.get(c.page_path) ?? { page_path: c.page_path, page_url: c.page_url, open: 0, total: 0 };
    p.total++;
    if (c.status === "open" || c.status === "in_progress") p.open++;
    pages.set(c.page_path, p);
  }
  return [...pages.values()].sort((a, b) => b.open - a.open);
}

export async function getFeedback(project: Project, id: string) {
  const rows = await db<Row[]>(`comments?id=eq.${id}&project_id=eq.${project.id}&select=${SELECT}&limit=1`);
  const target = rows[0];
  if (!target) return null;
  const root = target.parent_id ? (await db<Row[]>(`comments?id=eq.${target.parent_id}&select=${SELECT}&limit=1`))[0] ?? target : target;
  const thread = await db<Row[]>(`comments?or=(id.eq.${root.id},parent_id.eq.${root.id})&select=${SELECT}`);
  return shape(root, thread);
}

// One action on one item. `item` may carry: reply, status, resolve, reopen, assignee.
export async function actOn(project: Project, item: Row, agentName: string) {
  const id = String(item.comment_id ?? item.id ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { comment_id: id, error: "bad comment id" };
  const rows = await db<Row[]>(`comments?id=eq.${id}&project_id=eq.${project.id}&select=${SELECT}&limit=1`);
  let target = rows[0];
  if (!target) return { comment_id: id, error: "not found in this project" };
  if (target.parent_id) {
    const parent = await db<Row[]>(`comments?id=eq.${target.parent_id}&select=${SELECT}&limit=1`);
    if (parent[0]) target = parent[0];
  }
  const out: Row = { comment_id: target.id };

  const reply = (item.reply ?? item.text ?? "").toString().trim().slice(0, 4000);
  if (reply) {
    const who = await agentPersona(project);
    const inserted = await db<Row[]>("comments", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        project_id: project.id, parent_id: target.id, page_url: target.page_url, page_path: target.page_path,
        comment_text: reply, author_email: who.email, author_name: who.label ? agentName : who.name, author_role: who.role, via_agent: agentName,
      }),
    });
    out.reply_id = inserted[0]?.id;
  }

  const patch: Row = {};
  let status: string | undefined = item.status;
  if (item.resolve === true || item.resolve === "true") status = "resolved";
  if (item.reopen === true || item.reopen === "true") status = "open";
  if (status !== undefined) {
    if (!STATUSES.includes(status as Status)) return { ...out, error: `status must be one of ${STATUSES.join(", ")}` };
    patch.status = status;
  }
  if (item.assignee !== undefined) patch.assignee_email = item.assignee ? String(item.assignee).toLowerCase() : null;
  if (Object.keys(patch).length) {
    await db(`comments?id=eq.${target.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch) });
  }
  out.status = patch.status ?? target.status;
  if ("assignee_email" in patch) out.assignee = patch.assignee_email;
  if (!reply && !Object.keys(patch).length) out.error = "nothing to do: send reply, status, resolve:true, reopen:true or assignee";
  return out;
}
