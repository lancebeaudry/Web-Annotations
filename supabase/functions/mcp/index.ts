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

import { resolveProject, listFeedback, listPages, getFeedback, actOn, designFor, DESIGN_GUIDE, STATUSES, LABELS, EFFORTS, type Project } from "../_shared/feedback.ts";
import { check as designCheck } from "../_shared/designEngine.ts";

const PROTOCOL = "2025-03-26";
const VERSION = "2.7.0";

const TOOLS = [
  {
    name: "list_feedback",
    description: "List feedback items for this website project. Default: open items (status open, in_progress or waiting). Each item has an id, the page, the element selector, the current text and styles, the requested change, labels, effort, assignee and any replies. Items with kind 'reference' were captured on another site with the PinPoint Chrome extension: `source` holds the source URL, a screenshot, the element text and its computed styles, and the note says what to take from it; if page_path is empty it is not yet tied to a specific element on this site, and `source.for_page` (when set) names the page the reviewer had in mind.",
    inputSchema: { type: "object", properties: {
      status: { type: "string", enum: [...STATUSES, "all"], description: "Which items to list. 'open' includes in_progress and waiting." },
      page: { type: "string", description: "Only items on this page path, e.g. '/' or '/about'." },
      label: { type: "string", enum: [...LABELS], description: "Only items carrying this label." },
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
    description: "Set an item's status. Use 'resolved' only after the requested change is actually made; 'in_progress' when you start; 'waiting' when the client has to decide or supply something (say what you need in the reply); 'wont_fix' with a reply explaining why.",
    inputSchema: { type: "object", required: ["id", "status"], properties: { id: { type: "string" }, status: { type: "string", enum: [...STATUSES] }, reply: { type: "string", description: "Optional note posted with the status change." }, agent_name: { type: "string" } } },
  },
  { name: "assign", description: "Assign an item to a person by email (the owner or a collaborator), or pass an empty string to unassign.", inputSchema: { type: "object", required: ["id", "email"], properties: { id: { type: "string" }, email: { type: "string" } } } },
  {
    name: "triage",
    description: "Label an item and size it. labels: bug (something broken), copy (text change), design (layout/visual), content (client must write or supply content), photo (client must supply an image), decision (client must choose), feature (a request for something new rather than a fix). effort: quick (under 30 minutes), medium (a small build or content pass), large (a real build). Pass only the fields you want to change.",
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" }, labels: { type: "array", items: { type: "string", enum: [...LABELS] } }, effort: { type: "string", enum: [...EFFORTS, ""] , description: "Empty string clears it." } } },
  },
  { name: "project_info", description: "The project's name and site URL.", inputSchema: { type: "object", properties: {} } },
];

// Listed only when the project has design rules on.
const DESIGN_TOOLS = [
  { name: "design_rules", description: "The project's design system: colors, fonts, type sizes, radius, spacing, button and section styles, module variants and rules.", inputSchema: { type: "object", properties: {} } },
  {
    name: "design_check",
    description: "Check a style change against the design system before making it. Returns allowed, needs_decision or blocked, the rule involved, and the closest approved option.",
    inputSchema: {
      type: "object", required: ["element", "property", "value"],
      properties: {
        element: { type: "string", enum: ["button", "heading", "display", "text", "section", "logo", "form"] },
        property: { type: "string", description: "CSS property: background-color, color, border-color, border-radius, font-size, padding, or variant" },
        value: { type: "string", description: "The new value, e.g. #1a7f37 or 18px" },
        page_path: { type: "string" }, selector: { type: "string" },
        context: { type: "object", description: "Optional: surface or button style key, or the measured background and text colors", properties: { surface: { type: "string" }, button: { type: "string" }, background: { type: "string" }, text: { type: "string" }, current: { type: "string" } } },
        viewport_w: { type: "number" },
      },
    },
  },
];

const text = (v: unknown) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
const errorResult = (msg: string) => ({ content: [{ type: "text", text: msg }], isError: true });

async function callTool(project: Project, name: string, args: Record<string, any>) {
  switch (name) {
    case "list_feedback": return text(await listFeedback(project, { status: args.status ?? "open", page: args.page, label: args.label }));
    case "list_pages": return text({ pages: await listPages(project) });
    case "get_feedback": { const item = await getFeedback(project, String(args.id ?? "")); return item ? text(item) : errorResult("not found in this project"); }
    case "reply": return text(await actOn(project, { comment_id: args.id, reply: args.text }, args.agent_name || "AI assistant"));
    case "set_status": return text(await actOn(project, { comment_id: args.id, status: args.status, reply: args.reply }, args.agent_name || "AI assistant"));
    case "assign": return text(await actOn(project, { comment_id: args.id, assignee: args.email ?? "" }, "AI assistant"));
    case "triage": return text(await actOn(project, { comment_id: args.id, labels: args.labels, effort: args.effort }, "AI assistant"));
    case "design_rules": case "design_check": {
      const ds = await designFor(project);
      if (!ds) return errorResult("Design rules aren't switched on for this project.");
      if (name === "design_rules") return text({ version: ds.version, tokens: ds.tokens });
      const ctx = args.context && typeof args.context === "object" ? args.context : {};
      return text(designCheck(ds.tokens, {
        element: String(args.element || ""), property: String(args.property || ""), value: String(args.value || "").slice(0, 100),
        context: { surface: ctx.surface, button: ctx.button, background: ctx.background, text: ctx.text, current: ctx.current },
        target: { page_path: String(args.page_path || ""), selector: String(args.selector || "").slice(0, 300) },
        viewport_w: Number(args.viewport_w) || undefined,
      } as any));
    }
    case "project_info": return text({ name: project.name, site_url: project.site_url, share_link: `${project.site_url.replace(/\/$/, "")}/?pinpoint=${project.token}` });
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
        case "initialize": {
          const design = await designFor(project).catch(() => null);
          out.push(rpc(m.id, { protocolVersion: PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "pinpoint", version: VERSION }, instructions: (design ? DESIGN_GUIDE + " " : "") + `Feedback for the website project "${project.name}". First pass: triage every open item that has no labels — set labels and effort, set_status waiting (with a reply saying what you need) on anything the client must decide or supply, and assign photo/content requests to the client contact if one is known. Then work through what you own, quick items first; when a change is made, set_status resolved with a short reply. Never resolve what you did not complete; if blocked, reply with why and leave it open. Before finishing, list_feedback again to confirm nothing you handled is still open.` }));
          break;
        }
        case "ping": out.push(rpc(m.id, {})); break;
        case "tools/list": {
          const design = await designFor(project).catch(() => null);
          out.push(rpc(m.id, { tools: design ? [...TOOLS, ...DESIGN_TOOLS] : TOOLS }));
          break;
        }
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
