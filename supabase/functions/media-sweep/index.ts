// Avalanche Markup — attachment sweeper.
//
// Deleting a comment removes its row, but Storage objects are not removed by
// SQL. The comments_after_delete_tombstone trigger records each attachment
// path in attachment_tombstones; this function (called hourly by pg_cron via
// pg_net, or manually) deletes those objects, then sweeps orphans: objects in
// comment-media older than an hour that no comment references.
//
// Auth: x-notify-secret (same secret the notify trigger uses).
// Deploy: supabase functions deploy media-sweep --no-verify-jwt

import { SUPABASE_URL, svcHeaders, db, json } from "../_shared/db.ts";

const NOTIFY_SECRET = Deno.env.get("NOTIFY_SECRET") ?? "";
const BUCKET = "comment-media";

async function removeObjects(paths: string[]): Promise<number> {
  let removed = 0;
  for (let i = 0; i < paths.length; i += 100) {
    const batch = paths.slice(i, i + 100);
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}`, {
      method: "DELETE",
      headers: svcHeaders(),
      body: JSON.stringify({ prefixes: batch }),
    });
    if (res.ok) removed += batch.length;
    else console.error(`remove batch failed: ${res.status} ${await res.text()}`);
  }
  return removed;
}

async function listAll(prefix = ""): Promise<{ name: string; created_at: string }[]> {
  // Storage list is per "folder"; comment-media is <projectId>/<file>, so
  // list the top level (project folders) then each folder.
  const out: { name: string; created_at: string }[] = [];
  const list = async (p: string) => {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, {
      method: "POST",
      headers: svcHeaders(),
      body: JSON.stringify({ prefix: p, limit: 1000, offset: 0, sortBy: { column: "name", order: "asc" } }),
    });
    if (!res.ok) throw new Error(`list ${p}: ${res.status}`);
    return (await res.json()) as { name: string; id: string | null; created_at: string }[];
  };
  for (const folder of await list(prefix)) {
    if (folder.id === null) {
      for (const f of await list(`${folder.name}/`)) {
        if (f.id !== null) out.push({ name: `${folder.name}/${f.name}`, created_at: f.created_at });
      }
    }
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  if (!NOTIFY_SECRET || req.headers.get("x-notify-secret") !== NOTIFY_SECRET) return json(401, { error: "bad secret" });

  // 1. tombstones
  const tombs = await db<{ path: string }[]>(`attachment_tombstones?select=path&limit=1000`);
  const tombPaths = tombs.map((t) => t.path).filter(Boolean);
  const removedTombs = tombPaths.length ? await removeObjects(tombPaths) : 0;
  if (tombPaths.length) {
    await db(`attachment_tombstones?path=in.(${tombPaths.map((p) => `"${p.replace(/"/g, '\\"')}"`).join(",")})`, { method: "DELETE" });
  }

  // 2. orphans: referenced paths from comments.attachments
  const rows = await db<{ attachments: { url?: string }[] }[]>(`comments?select=attachments&attachments=neq.[]`);
  const referenced = new Set<string>();
  for (const r of rows) {
    for (const a of r.attachments ?? []) {
      const m = (a.url ?? "").match(/\/comment-media\/(.+)$/);
      if (m) referenced.add(decodeURIComponent(m[1]));
    }
  }
  const cutoff = Date.now() - 60 * 60 * 1000;
  const orphans = (await listAll()).filter((o) => !referenced.has(o.name) && new Date(o.created_at).getTime() < cutoff).map((o) => o.name);
  const removedOrphans = orphans.length ? await removeObjects(orphans) : 0;

  return json(200, { tombstones: removedTombs, orphans: removedOrphans, referenced: referenced.size });
});
