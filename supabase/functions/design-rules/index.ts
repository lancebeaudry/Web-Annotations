// PinPoint — design rules.
//
// POST /functions/v1/design-rules  (user JWT)  { project_id, action, ... }
//
//   rules            the project's design system + what the caller may do
//   check            check a requested style change (no writes)
//   decide           record the reviewer's choice on a comment:
//                      apply | closest | exception | rule_change | send
//   flag             record that a plain comment goes against the design
//                      system ({ comment_id, request, direction }); re-checked here
//   approve, reject  an approver decides a rule change or an exception request
//   revert           undo an applied change (connector sites)
//   test, import     owner: test the site connector / pull its design system
//   draft_approve, draft_discard  owner: act on a draft an AI assistant sent in
//   import_url       owner: import from a style guide page or tokens file
//                      ({ url }; no url = re-import from the last address)
//
// Called from the overlay on any client site, so CORS reflects the caller's
// origin; every action is gated by the signed-in user's own access, computed
// by the database (design_rules_access). Identity always comes from the JWT.
// Deploy: supabase functions deploy design-rules --no-verify-jwt --use-api

import { db, json, SUPABASE_URL, ANON_KEY } from "../_shared/db.ts";
import { requireUser } from "../_shared/auth.ts";
import * as E from "../_shared/designEngine.ts";
import { connectorFor, call } from "../_shared/designConnector.ts";
import { importFromUrl } from "../_shared/designImport.ts";

const cors = (req: Request) => ({
  "Access-Control-Allow-Origin": req.headers.get("origin") || "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  Vary: "Origin",
});
const UNREACHABLE = "Couldn't reach the site's design rules. Nothing was changed.";
const prodCache = new Map<string, { at: number; version: string | null }>();

const str = (v: unknown, n: number) => String(v ?? "").slice(0, n);
const word = (v: unknown, n = 40) => String(v ?? "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, n);
function cleanRequest(r: any): E.Request {
  const ctx = r?.context || {}, tg = r?.target || {};
  return {
    element: word(r?.element) || "text",
    property: String(r?.property ?? "").toLowerCase().replace(/[^a-z-]/g, "").slice(0, 40),
    value: str(r?.value, 64).trim(),
    context: {
      surface: word(ctx.surface) || undefined, button: word(ctx.button) || undefined,
      background: E.normalizeHex(ctx.background) || undefined, text: E.normalizeHex(ctx.text) || undefined,
      current: str(ctx.current, 64) || undefined,
    },
    target: {
      page_id: Number.isFinite(+tg.page_id) ? Math.max(0, Math.floor(+tg.page_id)) : 0,
      node_id: word(tg.node_id, 64), module: word(tg.module, 64), setting: word(tg.setting, 64),
      selector: str(tg.selector, 300), page_path: str(tg.page_path, 300),
    },
    viewport_w: Number.isFinite(+r?.viewport_w) ? Math.floor(+r.viewport_w) : undefined,
  };
}

async function access(authz: string, pid: string): Promise<any> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/design_rules_access`, {
    method: "POST", headers: { apikey: ANON_KEY, Authorization: authz, "Content-Type": "application/json" },
    body: JSON.stringify({ p_project: pid }),
  });
  return r.ok ? await r.json() : { enabled: false };
}
async function isOwnerOrOperator(uid: string, project: any) {
  if (project.owner_id === uid) return true;
  return (await db<any[]>(`operators?user_id=eq.${uid}&select=user_id&limit=1`)).length > 0;
}
async function approverEmail(project: any): Promise<string | null> {
  const a = String(project.design_rules?.approver_email || "").toLowerCase();
  if (a) return a;
  const u = await db<any[]>(`rpc/project_owner_email`, { method: "POST", body: JSON.stringify({ p_project: project.id }) }).catch(() => null);
  return typeof u === "string" ? u : null;
}
async function tokensOf(pid: string) {
  const r = await db<any[]>(`design_systems?project_id=eq.${pid}&select=tokens,version,updated_at,source,source_url,share_token&limit=1`);
  return r[0] || null;
}
async function saveTokens(pid: string, tokens: any, version: string, by: string, source: string, sourceUrl: string | null = null) {
  await db(`design_systems?on_conflict=project_id`, {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ project_id: pid, tokens: { ...tokens, version }, version, updated_at: new Date().toISOString(), updated_by: by, source, source_url: sourceUrl }),
  });
}
// Same design system apart from the version and date stamps?
// Key order doesn't count (the database stores tokens as jsonb, which
// reorders keys).
const canon = (v: any): string => Array.isArray(v) ? `[${v.map(canon).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`
  : JSON.stringify(v);
const sameTokens = (a: any, b: any) => {
  const strip = (t: any) => { const { version: _v, updated: _u, ...rest } = t || {}; return canon(rest); };
  return strip(a) === strip(b);
};
async function log(pid: string, version: string, kind: string, summary: string, by: string, changes: any = null) {
  await db("design_changelog", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ project_id: pid, version, kind, summary: summary.slice(0, 300), changes, by }) });
}
async function rateLimited(uid: string): Promise<boolean> {
  const since = new Date(Date.now() - 60_000).toISOString();
  const hits = await db<any[]>(`design_rule_hits?user_id=eq.${uid}&at=gte.${since}&select=at`);
  if (hits.length >= 30) return true;
  await db("design_rule_hits", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ user_id: uid }) });
  if (Math.random() < 0.05) await db(`design_rule_hits?at=lt.${new Date(Date.now() - 3_600_000).toISOString()}`, { method: "DELETE" }).catch(() => {});
  return false;
}
async function patchComment(id: string, patch: Record<string, unknown>) {
  const rows = await db<any[]>(`comments?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch) });
  return rows[0];
}
const withLabel = (labels: string[] | null, l: string) => [...new Set([...(labels || []), l])];
const realEmail = (e: string) => (/@/.test(e || "") && !/^(guest|agent):/.test(e) ? e.toLowerCase() : null);

Deno.serve(async (req) => {
  const h = cors(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: h });
  if (req.method !== "POST") return json(405, { error: "POST only" }, h);
  const caller = await requireUser(req, h);
  if (caller instanceof Response) return caller;
  const authz = req.headers.get("authorization") || "";
  let b: any;
  try { b = await req.json(); } catch { return json(400, { error: "bad JSON" }, h); }
  const pid = String(b.project_id || "");
  if (!/^[0-9a-f-]{36}$/i.test(pid)) return json(400, { error: "project_id required" }, h);
  const projects = await db<any[]>(`projects?id=eq.${pid}&select=id,name,owner_id,token,site_url,design_rules&limit=1`);
  const project = projects[0];
  if (!project) return json(404, { error: "project not found" }, h);
  const acc = await access(authz, pid);
  const me = caller.email.toLowerCase();
  const action = String(b.action || "");

  // ---- owner: use or discard a draft an AI assistant sent in
  if (action === "draft_approve" || action === "draft_discard") {
    if (!(await isOwnerOrOperator(caller.id, project))) return json(403, { error: "Only the project owner can do this." }, h);
    const row = (await db<any[]>(`design_systems?project_id=eq.${pid}&select=tokens,version,draft,draft_by&limit=1`))[0];
    if (!row?.draft) return json(404, { error: "There's no draft waiting." }, h);
    const clear = { draft: null, draft_summary: null, draft_by: null, draft_at: null };
    if (action === "draft_discard") {
      await db(`design_systems?project_id=eq.${pid}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(clear) });
      return json(200, { ok: true, discarded: true }, h);
    }
    const problems = E.validateTokens(row.draft);
    if (problems.length) return json(422, { error: `The draft has problems: ${problems.slice(0, 3).join(" ")}` }, h);
    const had = row.tokens?.color ? row.version : null;
    let version = String(row.draft.version || "1.0.0").slice(0, 20);
    if (had && !E.semverGt(version, had)) version = E.bumpVersion(had);
    await saveTokens(pid, row.draft, version, me, "assistant");
    await db(`design_systems?project_id=eq.${pid}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(clear) });
    await log(pid, version, "import", `Draft from ${row.draft_by || "an AI assistant"} approved`, me);
    return json(200, { ok: true, version }, h);
  }

  // ---- owner: import from a style guide page or tokens file
  if (action === "import_url") {
    if (!(await isOwnerOrOperator(caller.id, project))) return json(403, { error: "Only the project owner can do this." }, h);
    const cur = await tokensOf(pid);
    const raw = str(b.url, 500).trim() || cur?.source_url || "";
    if (!raw) return json(400, { error: "Paste the address of the design system page." }, h);
    const got = await importFromUrl(raw);
    if ("error" in got) return json(422, { error: got.error }, h);
    const t = got.tokens;
    if (JSON.stringify(t).length > 200_000) return json(422, { error: "That design system is too large." }, h);
    if (cur?.tokens?.color && sameTokens(cur.tokens, t)) {
      if (cur.source_url !== got.from) await db(`design_systems?project_id=eq.${pid}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ source_url: got.from, source: "url" }) });
      return json(200, { ok: true, unchanged: true, version: cur.version, from: got.from }, h);
    }
    let version = String(t.version || "1.0.0").slice(0, 20);
    if (cur?.version && !E.semverGt(version, cur.version)) version = E.bumpVersion(cur.version);
    await saveTokens(pid, t, version, me, "url", got.from);
    await log(pid, version, "import", `Imported from ${got.from}`, me);
    return json(200, { ok: true, version, from: got.from, colors: Object.keys(t.color || {}).length, buttons: Object.keys(t.buttons || {}).length, surfaces: Object.keys(t.surfaces || {}).length }, h);
  }

  // ---- owner tools: test / import (work before the feature is switched on)
  if (action === "test" || action === "import") {
    if (!(await isOwnerOrOperator(caller.id, project))) return json(403, { error: "Only the project owner can do this." }, h);
    const prod = b.prod === true;
    const conn = await connectorFor(project, prod);
    if (!conn) return json(400, { error: prod ? "Add the production rules API address and key first." : "Add the site rules API address and key first." }, h);
    const r = await call(conn, "rules");
    if (!r.ok || !r.data?.tokens) return json(502, { error: r.status === 401 || r.status === 403 ? "The site refused the key. Paste the current key from the site." : UNREACHABLE }, h);
    const t = r.data.tokens;
    const summary = { version: r.data.version || t.version, colors: Object.keys(t.color || {}).length, buttons: Object.keys(t.buttons || {}).length, surfaces: Object.keys(t.surfaces || {}).length, rules: (t.rules?.hard || []).length + (t.rules?.soft || []).length };
    if (action === "test" || prod) return json(200, { ok: true, ...summary }, h);
    const version = String(summary.version || "1.0.0");
    await saveTokens(pid, t, version, me, "connector");
    await log(pid, version, "import", "Design system imported from the site", me);
    return json(200, { ok: true, imported: true, ...summary }, h);
  }

  if (!acc.enabled) return json(403, { error: "Design rules aren't switched on for this project." }, h);
  const ds = await tokensOf(pid);
  const tokens = ds?.tokens || null;

  // ---- rules
  if (action === "rules") {
    let prod: string | null = null;
    if (project.design_rules?.connector?.prod_url) {
      const c = prodCache.get(pid);
      if (c && Date.now() - c.at < 300_000) prod = c.version;
      else {
        const conn = await connectorFor(project, true);
        const r = conn ? await call(conn, "rules") : null;
        prod = r?.ok ? String(r.data?.version || r.data?.tokens?.version || "") || null : null;
        prodCache.set(pid, { at: Date.now(), version: prod });
      }
    }
    // The view-only share token only goes to members (it opens the public page).
    return json(200, { tokens, version: ds?.version || null, updated_at: ds?.updated_at || null, access: acc, production_version: prod, share_token: acc.can_check ? ds?.share_token || null : null }, h);
  }

  if (!acc.can_check) return json(403, { error: "Only project members can use design rules." }, h);
  if (!tokens || !tokens.color) return json(409, { error: "This project has no design system yet. The owner can add one in the dashboard." }, h);

  // ---- check
  if (action === "check") {
    if (await rateLimited(caller.id)) return json(429, { error: "That's a lot of checks in a minute. Try again shortly." }, h);
    return json(200, { result: E.check(tokens, cleanRequest(b.request)) }, h);
  }

  // Everything below acts on one comment.
  const cid = String(b.comment_id || "");
  if (!/^[0-9a-f-]{36}$/i.test(cid)) return json(400, { error: "comment_id required" }, h);
  const crow = (await db<any[]>(`comments?id=eq.${cid}&project_id=eq.${pid}&select=id,author_email,design_check,status,labels,assignee_email,page_path,page_url&limit=1`))[0];
  if (!crow) return json(404, { error: "That comment isn't in this project." }, h);
  const conn = acc.connected ? await connectorFor(project) : null;
  const approver = (await approverEmail(project)) || null;
  const now = new Date().toISOString();

  // ---- flag: a plain comment that reads as a style change
  if (action === "flag") {
    const isAuthor = (crow.author_email || "").toLowerCase() === me;
    if (!isAuthor && !acc.can_revert) return json(403, { error: "Only the person who wrote it, or a manager, can flag this." }, h);
    if (crow.design_check) return json(200, { comment: null, flagged: false }, h);
    const request = cleanRequest(b.request);
    if (!request.target?.page_path) request.target = { ...request.target, page_path: crow.page_path };
    const dir = b.direction === "less" || b.direction === "more" ? b.direction : "";
    const r = E.hint(tokens, request, dir);
    if (!r || r.status === "allowed" || r.info) return json(200, { comment: null, flagged: false }, h);
    const dc = { state: "flagged", request, direction: dir, result: { status: r.status, rule: r.rule, message: r.message }, tokens_version: r.tokens_version, decided_by: me, decided_at: now };
    return json(200, { comment: await patchComment(cid, { design_check: dc, labels: withLabel(crow.labels, "design") }), flagged: true }, h);
  }

  // ---- decide
  if (action === "decide") {
    const isAuthor = (crow.author_email || "").toLowerCase() === me;
    if (!isAuthor && !acc.can_revert) return json(403, { error: "Only the person who asked, or a manager, can choose here." }, h);
    const prev = crow.design_check;
    if (prev && !["rejected", "exception_rejected", "reverted", "flagged"].includes(prev.state)) return json(409, { error: "A choice is already recorded on this item." }, h);
    const request = cleanRequest(b.request);
    if (!request.target?.page_path) request.target = { ...request.target, page_path: crow.page_path };
    const result = E.check(tokens, request);
    if (b.tokens_version && String(b.tokens_version) !== result.tokens_version) {
      return json(409, { error: "RULES_CHANGED", message: "The design system changed since you checked. Here's the new answer.", result }, h);
    }
    const choice = String(b.choice || "");
    const base: any = {
      request, result: { status: result.status, rule: result.rule, message: result.message, contrast: result.contrast || null, device_note: result.device_note || null },
      tokens_version: result.tokens_version, choice, decided_by: me, decided_at: now,
    };
    let patch: Record<string, unknown> = {};

    const applyOption = async (opt: any) => {
      const a = opt.action || {};
      const settingFor = request.target?.setting || (a.kind === "button" ? "button_style" : a.kind === "surface" ? "surface" : a.setting || "");
      const canSite = conn && ["set_variant", "set_setting"].includes(a.type) && request.target?.page_id && request.target?.node_id && settingFor;
      if (canSite) {
        const r = await call(conn!, "apply", { body: { page_id: request.target!.page_id, node_id: request.target!.node_id, setting: settingFor, value: a.value } });
        if (r.ok) {
          return { ...base, state: "applied", applied: { setting: settingFor, value: a.value, label: a.label || a.value, previous: request.context?.button || request.context?.surface || request.context?.current || null } };
        }
        if (r.status === 0 || r.status >= 500) throw new Error("unreachable");
      }
      return { ...base, state: "task", task: E.taskSpec(request, choice === "apply" ? "apply" : "closest", choice === "apply" ? null : opt, tokens), option: { summary: opt.summary || null, value: opt.value || a.value || null, token: opt.token || null } };
    };

    try {
      if (choice === "apply" || choice === "closest") {
        let opt: any;
        if (choice === "apply") {
          if (result.status !== "allowed") return json(409, { error: "That change isn't approved as-is. Pick one of the choices.", result }, h);
          opt = { action: result.apply || { type: "set_style", property: request.property, value: request.value }, value: request.value, token: result.token };
        } else {
          opt = (result.options || []).find((o) => o.id === "closest");
          if (!opt) return json(409, { error: "There's no closest approved style for this.", result }, h);
          if (opt.choices) {
            const v = word(b.variant, 64);
            if (!opt.choices.includes(v)) return json(400, { error: "Pick one of the approved variants." }, h);
            opt = { ...opt, value: v, action: { ...opt.action, value: v }, summary: `Use the "${v}" variant.` };
          }
        }
        const dc = await applyOption(opt);
        patch = { design_check: dc, labels: withLabel(crow.labels, "design"), status: dc.state === "applied" ? "resolved" : "in_progress" };
      } else if (choice === "exception") {
        const reason = str(b.reason, 500).trim();
        if (reason.length < 3) return json(400, { error: "Add a short reason for the exception." }, h);
        const opt = (result.options || []).find((o) => o.id === "exception");
        if (!opt) return json(409, { error: "This can't be an exception.", result }, h);
        if (acc.can_except) {
          const dc = await logException(project, conn, crow, request, reason, me, base, tokens);
          patch = { design_check: dc, labels: withLabel(crow.labels, "design"), status: dc.state === "exception_applied" ? "resolved" : "in_progress" };
        } else {
          patch = { design_check: { ...base, state: "exception_requested", reason }, labels: withLabel(crow.labels, "design"), status: "waiting", assignee_email: approver };
        }
      } else if (choice === "rule_change") {
        const rc = (result.options || []).find((o) => o.id === "rule_change");
        const scope = rc?.scopes?.find((s: any) => s.id === String(b.scope_id || ""));
        if (!scope) return json(400, { error: "Pick how the rule should change." }, h);
        const changes = E.cleanChanges(scope.changes);
        const problem = E.hardRuleProblem(E.applyChanges(tokens, changes));
        if (problem) return json(422, { error: problem }, h);
        const then = scope.then ? { ...scope.then, page_id: request.target?.page_id, node_id: request.target?.node_id, setting: request.target?.setting || (scope.then.kind === "button" ? "button_style" : "surface") } : null;
        let affected: any[] = [], connector_id: string | null = null;
        if (conn) {
          const r = await call(conn, "proposals", { body: { changes, summary: scope.label, requested_by: me, source: "pinpoint", source_ref: cid, then } });
          if (r.status === 422) return json(422, { error: "The site says this change would break a hard rule." }, h);
          if (!r.ok) throw new Error("unreachable");
          connector_id = String(r.data?.id || "") || null;
          affected = (r.data?.affected || []).slice(0, 50).map((p: any) => ({ title: str(p.title, 120), url: str(p.url, 400), preview_url: str(p.preview_url, 500) }));
        }
        const prop = (await db<any[]>("design_proposals", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({
          project_id: pid, comment_id: cid, summary: scope.label, changes, then_apply: then, requested_by: me, version_from: result.tokens_version, affected, connector_id,
        }) }))[0];
        patch = {
          design_check: { ...base, state: "proposal_pending", proposal_id: prop.id, scope: { id: scope.id, label: scope.label, impact: scope.impact || null }, affected, preview_id: connector_id },
          labels: withLabel(crow.labels, "design"), status: "waiting", assignee_email: approver,
        };
      } else if (choice === "send") {
        patch = { design_check: { ...base, state: "sent_to_team" }, labels: withLabel(crow.labels, "design"), status: "open", assignee_email: approver };
      } else {
        return json(400, { error: "Unknown choice." }, h);
      }
    } catch (_e) {
      return json(502, { error: UNREACHABLE }, h);
    }
    return json(200, { comment: await patchComment(cid, patch) }, h);
  }

  // ---- approve / reject
  if (action === "approve" || action === "reject") {
    if (!acc.can_approve) return json(403, { error: "You can't approve design changes on this project." }, h);
    const dc = crow.design_check || {};
    const requester = realEmail(crow.author_email);
    if (dc.state === "exception_requested") {
      if (action === "reject") {
        return json(200, { comment: await patchComment(cid, { design_check: { ...dc, state: "exception_rejected", decided_by: me, decided_at: now }, status: "open", assignee_email: requester }) }, h);
      }
      try {
        const next = await logException(project, conn, crow, dc.request, dc.reason || "Approved exception", me, dc, tokens);
        return json(200, { comment: await patchComment(cid, { design_check: { ...next, approved_by: me }, status: next.state === "exception_applied" ? "resolved" : "in_progress", assignee_email: null }) }, h);
      } catch { return json(502, { error: UNREACHABLE }, h); }
    }
    if (dc.state !== "proposal_pending" || !dc.proposal_id) return json(409, { error: "There's nothing waiting for approval on this item." }, h);
    const prop = (await db<any[]>(`design_proposals?id=eq.${dc.proposal_id}&project_id=eq.${pid}&select=*&limit=1`))[0];
    if (!prop || prop.status !== "pending") return json(409, { error: "This proposal was already decided." }, h);
    if (action === "reject") {
      if (conn && prop.connector_id) await call(conn, `proposals/${prop.connector_id}/reject`, { body: {} });
      await db(`design_proposals?id=eq.${prop.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "rejected", decided_by: me, decided_at: now }) });
      return json(200, { comment: await patchComment(cid, { design_check: { ...dc, state: "rejected", decided_by: me, decided_at: now }, status: "open", assignee_email: requester }) }, h);
    }
    let version: string, applied = false;
    if (conn && prop.connector_id) {
      const r = await call(conn, `proposals/${prop.connector_id}/approve`, { body: { approved_by: me } });
      if (!r.ok) return json(502, { error: UNREACHABLE }, h);
      const pull = await call(conn, "rules");
      const t = pull.ok && pull.data?.tokens ? pull.data.tokens : E.applyChanges(tokens, prop.changes);
      version = String(r.data?.version || pull.data?.version || E.bumpVersion(ds.version));
      await saveTokens(pid, t, version, me, "connector");
      applied = true;
    } else {
      version = E.bumpVersion(ds.version);
      await saveTokens(pid, E.applyChanges(tokens, prop.changes), version, me, ds.source || "pinpoint");
    }
    await db(`design_proposals?id=eq.${prop.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "approved", decided_by: me, decided_at: now, version_to: version }) });
    await log(pid, version, "rule_change", prop.summary, me, prop.changes);
    const next = applied
      ? { ...dc, state: "approved_applied", approved_by: me, approved_version: version, decided_at: now }
      : { ...dc, state: "approved_task", approved_by: me, approved_version: version, decided_at: now, task: E.taskSpec(dc.request, "rule_change", { label: prop.summary, then: prop.then_apply }, tokens) };
    return json(200, { comment: await patchComment(cid, { design_check: next, status: applied ? "resolved" : "in_progress", assignee_email: null }) }, h);
  }

  // ---- revert
  if (action === "revert") {
    if (!acc.can_revert) return json(403, { error: "Only the owner or a manager can undo this." }, h);
    const dc = crow.design_check || {};
    if (dc.state !== "applied" || !dc.applied?.previous) return json(409, { error: "There's no earlier value to go back to. Change it again from the page instead." }, h);
    if (!conn) return json(409, { error: "Undo needs the site connector." }, h);
    const r = await call(conn, "apply", { body: { page_id: dc.request?.target?.page_id, node_id: dc.request?.target?.node_id, setting: dc.applied.setting, value: dc.applied.previous } });
    if (!r.ok) return json(r.status === 422 ? 409 : 502, { error: r.status === 422 ? "The earlier value isn't approved any more, so it can't be restored automatically." : UNREACHABLE }, h);
    return json(200, { comment: await patchComment(cid, { design_check: { ...dc, state: "reverted", reverted_by: me, reverted_at: now }, status: "open" }) }, h);
  }

  return json(400, { error: "Unknown action." }, h);
});

async function logException(project: any, conn: any, crow: any, request: E.Request, reason: string, me: string, base: any, tokens: any) {
  const t = request.target || {};
  let connector_id: string | null = null, onSite = false;
  if (conn && t.page_id && t.selector) {
    const r = await call(conn, "exceptions", { body: { page_id: t.page_id, selector: t.selector, property: request.property, value: request.value, reason, requested_by: me, source: "pinpoint" } });
    if (r.ok) { connector_id = String(r.data?.id || "") || null; onSite = true; }
    else if (r.status === 0 || r.status >= 500) throw new Error("unreachable");
  }
  const ex = (await db<any[]>("design_exceptions", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({
    project_id: project.id, comment_id: crow.id, page_path: t.page_path || crow.page_path, selector: t.selector || null, property: request.property, value: request.value, reason, created_by: me, connector_id,
  }) }))[0];
  await db("design_changelog", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ project_id: project.id, version: String(tokens.version || "1.0.0"), kind: "exception", summary: `One-off exception on ${t.page_path || crow.page_path}: ${request.property} ${request.value}`, by: me }) });
  return onSite
    ? { ...base, state: "exception_applied", exception_id: ex.id, reason }
    : { ...base, state: "exception_logged", exception_id: ex.id, reason, task: E.taskSpec(request, "exception", null, tokens) };
}
