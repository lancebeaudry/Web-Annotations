// PinPoint — hosted MCP server (Streamable HTTP, JSON responses).
//
// Lets Claude Code, Cursor and other MCP clients see PinPoint feedback as
// first-class tools. No install: the client is pointed at this URL with the
// project's agent key as a header.
//
//   claude mcp add --transport http pinpoint \
//     https://<ref>.supabase.co/functions/v1/mcp \
//     --header "x-pinpoint-agent-key: pp_…"
//
// Implements the subset of MCP a tool server needs: initialize, ping,
// notifications/initialized, tools/list, tools/call. Stateless — every
// request is authenticated by the key, so no session ids are issued.
// Deploy: supabase functions deploy mcp --no-verify-jwt --use-api

import { resolveProject, listFeedback, listPages, getFeedback, actOn, STATUSES, type Project } from "../_shared/feedback.ts";

const PROTOCOL = "2025-03-26";
const VERSION = "2.2.0";

const TOOLS = [
  {
    name: "list_feedback",
    description: "List feedback items for this website project. Default: open items (status open or in_progress). Each item has an id, the page, the element selector, the current text and styles, the requested change and any replies.",
    inputSchema: { type: "object", properties: {
      status: { type: "string", enum: ["open", "in_progress", "resolved", "wont_fix", "all"], description: "Which items to list. 'open' includes in_progress." },
      page: { type: "string", description: "Only items on this page path, e.g. '/' or '/about'." },
    } },
  },
  { name: "list_pages", description: "Pages of the site that have feedback, with open and total counts.", inputSchema: { type: "object", properties: {} } },
  { name: "get_feedback", description: "Fetch one feedback item with its full thread.", inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } } },
  {
    name: "reply",
    description: "Post a reply on a feedback item (for example, what you changed, or why you could not). Does not change its status.",
    inputSchema: { type: "object", required: ["id", "text"], properties: { id: { type: "string" }, text: { type: "string" }, agent_name: { type: "string", description: "Name of the assistant, kept on the record. Replies are signed as the person the project chose unless the project shows AI replies as AI." } } },
  },
  {
    name: "set_status",
    description: "Set an item's status. Use 'resolved' only after the requested change is actually made; use 'in_progress' when you start; use 'wont_fix' with a reply explaining why.",
    inputSchema: { type: "object", required: ["id", "status"], properties: { id: { type: "string" }, status: { type: "string", enum: [...STATUSES] }, reply: { type: "string", description: "Optional note posted with the status change." }, agent_name: { type: "string" } } },
  },
  { name: "assign", description: "Assign an item to a person by email (the owner or a collaborator), or pass an empty string to unassign.", inputSchema: { type: "object", required: ["id", "email"], properties: { id: { type: "string" }, email: { type: "string" } } } },
  { name: "project_info", description: "The project's name and site URL.", inputSchema: { type: "object", properties: {} } },
];

const text = (v: unknown) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
const errorResult = (msg: string) => ({ content: [{ type: "text", text: msg }], isError: true });

async function callTool(project: Project, name: string, args: Record<string, any>) {
  switch (name) {
    case "list_feedback": return text(await listFeedback(project, { status: args.status ?? "open", page: args.page }));
    case "list_pages": return text({ pages: await listPages(project) });
    case "get_feedback": { const item = await getFeedback(project, String(args.id ?? "")); return item ? text(item) : errorResult("not found in this project"); }
    case "reply": return text(await actOn(project, { comment_id: args.id, reply: args.text }, args.agent_name || "AI assistant"));
    case "set_status": return text(await actOn(project, { comment_id: args.id, status: args.status, reply: args.reply }, args.agent_name || "AI assistant"));
    case "assign": return text(await actOn(project, { comment_id: args.id, assignee: args.email ?? "" }, "AI assistant"));
    case "project_info": return text({ name: project.name, site_url: project.site_url, share_link: `${project.site_url.replace(/\/$/, "")}/?markup=${project.token}` });
    default: return errorResult(`unknown tool ${name}`);
  }
}

const rpc = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
const respond = (status: number, body: unknown) =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, x-pinpoint-agent-key, mcp-session-id, mcp-protocol-version", "Access-Control-Allow-Methods": "POST, OPTIONS" } });
  }
  if (req.method === "GET") return respond(405, { error: "This MCP server uses JSON responses over POST; no SSE stream." });
  if (req.method !== "POST") return respond(405, { error: "POST only" });

  const project = await resolveProject(req).catch(() => null);
  if (!project) return respond(401, rpcError(null, -32001, "missing or unknown x-pinpoint-agent-key"));

  let msg: any;
  try { msg = await req.json(); } catch { return respond(400, rpcError(null, -32700, "parse error")); }
  const messages = Array.isArray(msg) ? msg : [msg];
  const out: unknown[] = [];
  for (const m of messages) {
    if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") { out.push(rpcError(m?.id ?? null, -32600, "invalid request")); continue; }
    if (m.id === undefined) continue; // notification (e.g. notifications/initialized): nothing to answer
    try {
      switch (m.method) {
        case "initialize":
          out.push(rpc(m.id, { protocolVersion: PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "pinpoint", version: VERSION }, instructions: `Feedback for the website project "${project.name}". Work through open items; when a change is made, set_status resolved with a short reply. Never resolve what you did not complete; if blocked, reply with why and leave it open. Before finishing, list_feedback again to confirm nothing you handled is still open.` }));
          break;
        case "ping": out.push(rpc(m.id, {})); break;
        case "tools/list": out.push(rpc(m.id, { tools: TOOLS })); break;
        case "tools/call": {
          const name = m.params?.name; const args = m.params?.arguments ?? {};
          out.push(rpc(m.id, await callTool(project, name, args)));
          break;
        }
        default: out.push(rpcError(m.id, -32601, `method not found: ${m.method}`));
      }
    } catch (e) {
      console.error("mcp:", m.method, e);
      out.push(rpcError(m.id, -32603, "internal error"));
    }
  }
  if (!out.length) return respond(202, null);
  return respond(200, Array.isArray(msg) ? out : out[0]);
});
