// PinPoint — daily roundup of new comments.
//
// For every project on notify_mode = 'daily', emails each address on its
// notify list one message listing the comments and replies since the last
// roundup (up to 3 days back on the first run), grouped by page, with deep
// links. Comments the recipient wrote themselves are left out; a recipient
// with nothing new gets no email.
//
//   POST /roundup { all: true }            x-notify-secret (pg_cron, daily)
//   POST /roundup { project_id }           x-notify-secret (manual run)
// Deploy: supabase functions deploy roundup --no-verify-jwt --use-api

import { db, json } from "../_shared/db.ts";
import { sendEmail, mailerConfigured, FOOTER_HTML, FOOTER_TEXT } from "../_shared/email.ts";
import { deepLink } from "../_shared/integrations.ts";

const NOTIFY_SECRET = Deno.env.get("NOTIFY_SECRET") ?? "";
const DASHBOARD_URL = (Deno.env.get("DASHBOARD_URL") ?? "").split(",")[0].trim().replace(/\/?$/, "/");
const esc = (s: string) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const STATUS: Record<string, string> = { open: "Open", in_progress: "In progress", waiting: "Waiting on client", resolved: "Resolved", wont_fix: "Won't fix" };

type Project = { id: string; name: string; site_url: string; token: string; notify_mode: string; notify_last_roundup: string | null };
type Row = Record<string, any>;

function who(c: Row): string {
  const e = String(c.author_email || "").toLowerCase();
  if (e.startsWith("guest:")) return c.author_name || "A guest";
  return c.author_name || e;
}

async function roundup(project: Project): Promise<{ sent: number; comments: number; to: string[] }> {
  const floor = new Date(Date.now() - 3 * 86_400_000);
  const since = project.notify_last_roundup && new Date(project.notify_last_roundup) > floor ? new Date(project.notify_last_roundup) : floor;
  const rows = await db<Row[]>(`comments?project_id=eq.${project.id}&created_at=gt.${since.toISOString()}&select=id,parent_id,page_url,page_path,comment_text,author_email,author_name,status,kind,created_at&order=created_at.asc&limit=500`);
  const now = new Date().toISOString();
  if (!rows.length) {
    await db(`projects?id=eq.${project.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ notify_last_roundup: now }) });
    return { sent: 0, comments: 0, to: [] };
  }
  const list = await db<{ email: string }[]>(`notify_recipients?project_id=eq.${project.id}&select=email`);
  const recipients = [...new Set(list.map((r) => (r.email || "").toLowerCase().trim()).filter(Boolean))];
  // Root comments may have been created before the window; fetch the parents of new replies.
  const parentIds = [...new Set(rows.filter((r) => r.parent_id).map((r) => r.parent_id))];
  const parents = parentIds.length ? await db<Row[]>(`comments?id=in.(${parentIds.join(",")})&select=id,page_url,page_path,comment_text,author_email,author_name,status`) : [];
  const parentOf = new Map(parents.map((p) => [p.id, p]));

  let sent = 0;
  for (const to of recipients) {
    const mine = rows.filter((c) => String(c.author_email || "").toLowerCase() !== to);
    if (!mine.length) continue;
    const byPage = new Map<string, Row[]>();
    for (const c of mine) { const k = c.page_path || (c.kind === "reference" ? "References" : "/"); if (!byPage.has(k)) byPage.set(k, []); byPage.get(k)!.push(c); }
    const roots = mine.filter((c) => !c.parent_id).length, replies = mine.length - roots;
    const lead = `${mine.length} new ${mine.length === 1 ? "item" : "items"} on ${project.name} since your last roundup: ${roots} new comment${roots === 1 ? "" : "s"}${replies ? ` and ${replies} repl${replies === 1 ? "y" : "ies"}` : ""}.`;
    let text = `${lead}\n`, html = `<p>${esc(lead)}</p>`;
    for (const [page, items] of byPage) {
      text += `\n${page}\n`; html += `<h3 style="margin:18px 0 6px;font-size:15px;color:#10283D">${esc(page)}</h3><ul style="margin:0 0 8px 18px;padding:0">`;
      for (const c of items) {
        const parent = c.parent_id ? parentOf.get(c.parent_id) : null;
        const snippet = String(c.comment_text || "").split("\n")[0].slice(0, 160);
        const prefix = parent ? `Reply on “${String(parent.comment_text || "").split("\n")[0].slice(0, 60)}”: ` : "";
        const link = deepLink({ id: project.id, name: project.name, site_url: project.site_url, token: project.token }, (parent ?? c) as any);
        const st = !parent && c.status && c.status !== "open" ? ` [${STATUS[c.status] || c.status}]` : "";
        text += `  - ${who(c)}: ${prefix}${snippet}${st}\n    ${link}\n`;
        html += `<li style="margin:0 0 8px"><b>${esc(who(c))}</b>: ${esc(prefix)}<a href="${esc(link)}" style="color:#1B6493">${esc(snippet)}</a>${st ? ` <span style="color:#888;font-size:12px">${esc(st.trim())}</span>` : ""}</li>`;
      }
      html += "</ul>";
    }
    const inbox = DASHBOARD_URL ? `${DASHBOARD_URL}#/projects/${project.id}/feedback` : "";
    if (inbox) { text += `\nEverything open: ${inbox}\n`; html += `<p style="margin-top:18px"><a href="${esc(inbox)}" style="display:inline-block;padding:8px 14px;background:#1B6493;color:#fff;border-radius:6px;text-decoration:none">Open the inbox</a></p>`; }
    html += `<p style="font-size:12px;color:#6b7a85">You get one roundup a day for this project. The project owner can switch to instant emails in the dashboard.</p>`;
    try {
      await sendEmail({ to, subject: `${project.name}: ${mine.length} new ${mine.length === 1 ? "item" : "items"} today`, text: text + FOOTER_TEXT, html: html + FOOTER_HTML, idempotencyKey: `roundup-${project.id}-${to}-${now.slice(0, 10)}` });
      sent++;
    } catch (e) { console.error("roundup send failed", to, e); }
  }
  await db(`projects?id=eq.${project.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ notify_last_roundup: now }) });
  return { sent, comments: rows.length, to: recipients };
}

const SELECT = "id,name,site_url,token,notify_mode,notify_last_roundup";

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  if (!NOTIFY_SECRET || req.headers.get("x-notify-secret") !== NOTIFY_SECRET) return json(401, { error: "bad secret" });
  let body: any;
  try { body = await req.json(); } catch { return json(400, { error: "bad JSON" }); }
  if (!mailerConfigured()) return json(200, { error: "mailer not configured" });
  const q = body.project_id ? `projects?id=eq.${body.project_id}&select=${SELECT}` : `projects?notify_mode=eq.daily&select=${SELECT}`;
  const projects = await db<Project[]>(q);
  const out: Record<string, unknown> = {};
  for (const p of projects) out[p.id] = await roundup(p).catch((e) => ({ error: String(e) }));
  return json(200, { projects: projects.length, results: out });
});
