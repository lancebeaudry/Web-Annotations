// Slack and ClickUp dispatch (Agency plan). Called by `notify` for every new
// comment and every status/assignee change. Config lives in `integrations`
// (service-role only): slack {webhook_url}, clickup {token, list_id}.
// External ids are kept on the comment (external_ref) so replies and status
// changes land on the same ClickUp task.

import { db } from "./db.ts";

type Row = Record<string, any>;
type Project = { id: string; name: string; site_url: string; token: string };
const LABEL: Record<string, string> = { open: "Open", in_progress: "In progress", resolved: "Resolved", wont_fix: "Won't fix" };
const esc = (s: string) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function deepLink(project: Project, record: Row) {
  const id = record.parent_id || record.id;
  return `${record.page_url}?markup=${encodeURIComponent(project.token)}&pp_comment=${id}`;
}

export async function dispatchIntegrations(event: "insert" | "update", record: Row, old: Row | null, project: Project) {
  const rows = await db<Row[]>(`integrations?project_id=eq.${project.id}&enabled=eq.true&select=kind,config`);
  if (!rows.length) return { ran: 0 };
  let ran = 0;
  for (const r of rows) {
    try {
      if (r.kind === "slack") await slack(r.config, event, record, old, project);
      else if (r.kind === "clickup") await clickup(r.config, event, record, old, project);
      ran++;
    } catch (e) {
      console.error(`integration ${r.kind} failed for ${record.id}:`, e);
    }
  }
  return { ran };
}

function who(record: Row) {
  const email = (record.author_email || "").toLowerCase();
  if (email.startsWith("agent:")) return `${record.author_name || "AI assistant"} (AI)`;
  if (email.startsWith("guest:")) return record.author_name || "A guest";
  return record.author_name || email;
}

// ---------------------------------------------------------------- Slack (incoming webhook)
async function slack(config: Row, event: string, record: Row, old: Row | null, project: Project) {
  const url = config.webhook_url;
  if (!url) return;
  const link = deepLink(project, record);
  let textLine: string;
  if (event === "insert") {
    const kind = record.parent_id ? "replied" : "left feedback";
    const snippet = (record.comment_text || "").slice(0, 300);
    textLine = `*${esc(who(record))}* ${kind} on *${esc(project.name)}* · ${esc(record.page_path)}\n> ${esc(snippet).replace(/\n/g, "\n> ")}\n<${link}|Open in PinPoint>`;
  } else {
    const bits: string[] = [];
    if (old && record.status !== old.status) bits.push(`status → *${LABEL[record.status] ?? record.status}*`);
    if (old && record.assignee_email !== old.assignee_email) bits.push(record.assignee_email ? `assigned to *${esc(record.assignee_email)}*` : "unassigned");
    if (!bits.length) return;
    textLine = `*${esc(project.name)}* · ${esc(record.page_path)}: ${bits.join(", ")}\n> ${esc((record.comment_text || "").slice(0, 160))}\n<${link}|Open in PinPoint>`;
  }
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: textLine }) });
  if (!res.ok) throw new Error(`slack ${res.status} ${await res.text()}`);
}

// ---------------------------------------------------------------- ClickUp (personal token + list)
const CU = "https://api.clickup.com/api/v2";
async function cu(token: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${CU}${path}`, { ...init, headers: { Authorization: token, "Content-Type": "application/json", ...(init.headers as Record<string, string> ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`clickup ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

function taskDescription(record: Row, project: Project) {
  const lines = [
    `Feedback from PinPoint on ${project.name} — ${record.page_url}`,
    ``,
    `Requested change: ${record.comment_text}`,
    record.element_tag ? `Element: <${record.element_tag}>` : "",
    record.selector ? `Selector: ${record.selector}` : "",
    record.current_text ? `Current text: "${String(record.current_text).slice(0, 200)}"` : "",
    record.viewport_w ? `Viewport: ${record.viewport_w}px wide` : "",
    `By: ${who(record)} (${record.author_role || "reviewer"})`,
    ``,
    `Open in PinPoint: ${deepLink(project, record)}`,
  ];
  return lines.filter((l) => l !== "").join("\n");
}

async function statusNameFor(token: string, listId: string, status: string): Promise<string | null> {
  const list = await cu(token, `/list/${listId}`);
  const names: string[] = (list.statuses || []).map((s: Row) => String(s.status).toLowerCase());
  const pick = (cands: string[]) => names.find((n) => cands.some((c) => n === c || n.includes(c))) ?? null;
  switch (status) {
    case "resolved": return pick(["complete", "done", "closed", "resolved"]);
    case "in_progress": return pick(["in progress", "doing", "working"]);
    case "wont_fix": return pick(["won't fix", "wont fix", "closed", "cancel", "complete"]);
    default: return pick(["to do", "open", "todo", "backlog"]) ?? names[0] ?? null;
  }
}

async function clickup(config: Row, event: string, record: Row, old: Row | null, project: Project) {
  const { token, list_id } = config;
  if (!token || !list_id) return;
  const rootId = record.parent_id || record.id;
  const root = record.parent_id ? (await db<Row[]>(`comments?id=eq.${rootId}&select=id,external_ref,comment_text,page_path,page_url,element_tag,selector,current_text,viewport_w,author_email,author_name,author_role,status&limit=1`))[0] : record;
  if (!root) return;
  let taskId: string | undefined = root.external_ref?.clickup_task_id;

  if (event === "insert" && !record.parent_id) {
    if (taskId) return;
    const name = `${record.page_path === "/" ? "Home" : record.page_path}: ${(record.comment_text || "").slice(0, 80)}`;
    const task = await cu(token, `/list/${list_id}/task`, { method: "POST", body: JSON.stringify({ name, description: taskDescription(record, project), tags: ["pinpoint"] }) });
    taskId = task.id;
    await db(`comments?id=eq.${record.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ external_ref: { ...(record.external_ref || {}), clickup_task_id: taskId, clickup_url: task.url } }) });
    return;
  }
  if (!taskId) return; // root was created before the integration existed
  if (event === "insert" && record.parent_id) {
    await cu(token, `/task/${taskId}/comment`, { method: "POST", body: JSON.stringify({ comment_text: `${who(record)}: ${record.comment_text}` }) });
    return;
  }
  if (event === "update" && old && record.status !== old.status) {
    const name = await statusNameFor(token, String(list_id), record.status);
    if (name) await cu(token, `/task/${taskId}`, { method: "PUT", body: JSON.stringify({ status: name }) });
    else await cu(token, `/task/${taskId}/comment`, { method: "POST", body: JSON.stringify({ comment_text: `PinPoint status: ${LABEL[record.status] ?? record.status}` }) });
  }
}

// Used by the dashboard's test button.
export async function testSlack(webhookUrl: string, projectName: string) {
  const res = await fetch(webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `PinPoint is connected to *${esc(projectName)}*. New feedback will show up here.` }) });
  if (!res.ok) throw new Error(`Slack said ${res.status}: ${(await res.text()).slice(0, 120)}`);
}
export async function testClickUp(token: string, listId: string) {
  const list = await cu(token, `/list/${listId}`);
  return { list_name: list.name as string, statuses: (list.statuses || []).map((s: Row) => s.status) };
}
