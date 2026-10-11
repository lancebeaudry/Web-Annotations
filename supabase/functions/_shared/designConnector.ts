// Optional site connector for design rules (a WordPress rules API, or any
// site that implements the same contract). The key lives in project_secrets
// and never leaves the server. It is sent as X-PinPoint-Key, and also under
// the project's own header name when one is set. Upstream error text is
// never passed on.
//
// Contract: GET /rules -> { version, tokens }, POST /apply, POST /exceptions,
// POST /proposals -> { id, affected: [{ title, url, preview_url }] },
// POST /proposals/{id}/approve -> { version }, POST /proposals/{id}/reject.

import { db } from "./db.ts";

export type Conn = { base: string; key: string; header: string };

export async function connectorFor(project: { id: string; design_rules?: any }, prod = false): Promise<Conn | null> {
  const base = String(project.design_rules?.connector?.[prod ? "prod_url" : "base_url"] || "").trim();
  if (!/^https?:\/\//.test(base)) return null;
  const s = await db<any[]>(`project_secrets?project_id=eq.${project.id}&select=design_connector_key,design_connector_prod_key&limit=1`);
  const key = (prod ? s[0]?.design_connector_prod_key || s[0]?.design_connector_key : s[0]?.design_connector_key) || "";
  if (!key) return null;
  const header = String(project.design_rules?.connector?.key_header || "");
  return { base: base.replace(/\/?$/, "/"), key, header: /^[A-Za-z0-9-]{1,40}$/.test(header) ? header : "" };
}

/** Call the connector. 8 s timeout, one retry on a 5xx or network error. */
export async function call(conn: Conn, path: string, init: { method?: string; body?: unknown } = {}): Promise<{ ok: boolean; status: number; data: any }> {
  const url = conn.base + path.replace(/^\//, "");
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await fetch(url, {
        method: init.method || (init.body ? "POST" : "GET"),
        headers: { "Content-Type": "application/json", "X-PinPoint-Key": conn.key, ...(conn.header ? { [conn.header]: conn.key } : {}) },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: ctl.signal,
      });
      clearTimeout(timer);
      let data: any = null;
      try { data = await res.json(); } catch { data = null; }
      if (res.status >= 500 && attempt === 0) continue;
      if (!res.ok) console.error(`connector ${path} -> ${res.status}`, JSON.stringify(data).slice(0, 300));
      return { ok: res.ok, status: res.status, data };
    } catch (e) {
      clearTimeout(timer);
      if (attempt === 0) continue;
      console.error(`connector ${path} failed`, String(e));
      return { ok: false, status: 0, data: null };
    }
  }
  return { ok: false, status: 0, data: null };
}
