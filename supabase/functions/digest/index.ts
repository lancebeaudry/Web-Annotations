// PinPoint — "Needs your decision" digest.
//
// Emails a project's collaborators the items that are waiting on them
// (status = waiting), grouped by page, each with a link that opens the item
// on the site. Two ways in:
//
//   POST /digest  { project_id, to?: string[] }     user JWT, owner/operator
//     Sends now. `to` narrows the recipients; default is every collaborator
//     plus anyone assigned a waiting item.
//   POST /digest  { all: true }                      x-notify-secret (pg_cron)
//     Weekly: every project with digest_weekly = true and at least one
//     waiting item.
//
// Deploy: supabase functions deploy digest --no-verify-jwt --use-api

import { db, json } from "../_shared/db.ts";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { requireUser } from "../_shared/auth.ts";
import { sendEmail, mailerConfigured, FOOTER_HTML, FOOTER_TEXT } from "../_shared/email.ts";
import { deepLink } from "../_shared/integrations.ts";

const NOTIFY_SECRET = Deno.env.get("NOTIFY_SECRET") ?? "";
const DASHBOARD_URL = (Deno.env.get("DASHBOARD_URL") ?? "").split(",")[0].trim().replace(/\/?$/, "/");
const esc = (s: string) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const LABEL: Record<string, string> = { bug: "Bug", copy: "Copy", design: "Design", content: "Content needed", photo: "Photo needed", decision: "Decision" };

type Project = { id: string; name: string; site_url: string; token: string; owner_id: string; digest_weekly: boolean };
type Item = Record<string, any>;

async function waitingItems(projectId: string): Promise<Item[]> {
  return await db<Item[]>(`comments?project_id=eq.${projectId}&parent_id=is.null&status=eq.waiting&select=id,page_url,page_path,comment_text,assignee_email,labels,created_at&order=page_path.asc,created_at.asc`);
}

async function recipientsFor(projectId: string, items: Item[]): Promise<string[]> {
  const members = await db<{ email: string }[]>(`project_members?project_id=eq.${projectId}&select=email`);
  const set = new Set<string>();
  for (const m of members) { const e = (m.email || "").toLowerCase().trim(); if (e && !e.startsWith("guest:")) set.add(e); }
  for (const it of items) { const e = (it.assignee_email || "").toLowerCase().trim(); if (e) set.add(e); }
  return [...set];
}

function render(project: Project, items: Item[], to: string) {
  const mine = items.filter((i) => (i.assignee_email || "").toLowerCase() === to);
  const rest = items.filter((i) => (i.assignee_email || "").toLowerCase() !== to);
  const inbox = DASHBOARD_URL ? `${DASHBOARD_URL}#/projects/${project.id}/feedback?status=waiting` : "";
  const line = (i: Item) => {
    const tags = (i.labels || []).map((l: string) => LABEL[l] || l).join(", ");
    const snippet = String(i.comment_text || "").split("\n")[0].slice(0, 140);
    return { snippet, tags, link: deepLink({ id: project.id, name: project.name, site_url: project.site_url, token: project.token }, i as any) };
  };
  const section = (title: string, list: Item[]) => {
    if (!list.length) return { text: "", html: "" };
    const byPage = new Map<string, Item[]>();
    for (const i of list) { if (!byPage.has(i.page_path)) byPage.set(i.page_path, []); byPage.get(i.page_path)!.push(i); }
    let text = `${title} (${list.length})\n`;
    let html = `<h3 style="margin:20px 0 6px;font-size:15px">${esc(title)} <span style="color:#888;font-weight:400">(${list.length})</span></h3>`;
    for (const [page, its] of byPage) {
      text += `\n  ${page}\n`;
      html += `<p style="margin:10px 0 4px;color:#555;font-size:13px">${esc(page)}</p><ul style="margin:0 0 8px 18px;padding:0">`;
      for (const i of its) {
        const l = line(i);
        text += `  - ${l.snippet}${l.tags ? ` [${l.tags}]` : ""}\n    ${l.link}\n`;
        html += `<li style="margin:0 0 6px"><a href="${esc(l.link)}" style="color:#1B6493">${esc(l.snippet)}</a>${l.tags ? ` <span style="color:#888;font-size:12px">${esc(l.tags)}</span>` : ""}</li>`;
      }
      html += "</ul>";
    }
    return { text, html };
  };
  const a = section("Assigned to you", mine);
  const b = section(mine.length ? "Also waiting on your team" : "Waiting on you", rest);
  const lead = `${items.length} item${items.length === 1 ? "" : "s"} on ${project.name} need${items.length === 1 ? "s" : ""} a decision or something from your side before work can continue. Click any item to open it on the site and reply there.`;
  const text = `${lead}\n\n${a.text}${a.text && b.text ? "\n" : ""}${b.text}\n${inbox ? `Everything waiting on you: ${inbox}\n` : ""}${FOOTER_TEXT}`;
  const html =
    `<p>${esc(lead)}</p>` + a.html + b.html +
    (inbox ? `<p style="margin-top:20px"><a href="${esc(inbox)}" style="display:inline-block;padding:8px 14px;background:#1B6493;color:#fff;border-radius:6px;text-decoration:none">See everything waiting on you</a></p>` : "") +
    FOOTER_HTML;
  const subject = `Needs your decision — ${project.name} (${items.length})`;
  return { subject, text, html };
}

async function sendDigest(project: Project, only?: string[]): Promise<{ sent: number; items: number; to: string[] }> {
  const items = await waitingItems(project.id);
  if (!items.length) return { sent: 0, items: 0, to: [] };
  let to = await recipientsFor(project.id, items);
  if (only && only.length) { const want = new Set(only.map((e) => e.toLowerCase().trim())); to = to.filter((e) => want.has(e)); for (const e of want) if (!to.includes(e)) to.push(e); }
  let sent = 0;
  for (const email of to) {
    const m = render(project, items, email);
    try { await sendEmail({ to: email, ...m, idempotencyKey: `digest-${project.id}-${email}-${new Date().toISOString().slice(0, 13)}` }); sent++; }
    catch (e) { console.error("digest send failed", email, e); }
  }
  if (sent) await db(`projects?id=eq.${project.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ digest_last_sent: new Date().toISOString() }) });
  return { sent, items: items.length, to };
}

const SELECT = "id,name,site_url,token,owner_id,digest_weekly";

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  const cors = corsHeaders(req);
  if (req.method !== "POST") return json(405, { error: "POST only" }, cors);
  let body: any;
  try { body = await req.json(); } catch { return json(400, { error: "bad JSON" }, cors); }
  if (!mailerConfigured()) return json(200, { error: "mailer not configured" }, cors);

  // Scheduled: every opted-in project with waiting items.
  if (body.all === true) {
    if (!NOTIFY_SECRET || req.headers.get("x-notify-secret") !== NOTIFY_SECRET) return json(401, { error: "bad secret" }, cors);
    const projects = await db<Project[]>(`projects?digest_weekly=eq.true&select=${SELECT}`);
    const out: Record<string, unknown> = {};
    for (const p of projects) out[p.id] = await sendDigest(p).catch((e) => ({ error: String(e) }));
    return json(200, { projects: projects.length, results: out }, cors);
  }

  // On demand: the owner (or an operator) sends it now.
  const caller = await requireUser(req, cors);
  if (caller instanceof Response) return caller;
  const pid = String(body.project_id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(pid)) return json(400, { error: "project_id required" }, cors);
  const projects = await db<Project[]>(`projects?id=eq.${pid}&select=${SELECT}&limit=1`);
  const project = projects[0];
  if (!project) return json(404, { error: "project not found" }, cors);
  const ops = await db<any[]>(`operators?user_id=eq.${caller.id}&select=user_id&limit=1`);
  if (project.owner_id !== caller.id && !ops.length) return json(403, { error: "not the project owner" }, cors);
  const only = Array.isArray(body.to) ? body.to.map(String) : undefined;
  return json(200, await sendDigest(project, only), cors);
});
