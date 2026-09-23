// PinPoint — attachment sweeper.
//
// Deleting a comment removes its row, but Storage objects are not removed by
// SQL. The comments_after_delete_tombstone trigger records each attachment
// path in attachment_tombstones; this function (called hourly by pg_cron via
// pg_net, or manually) deletes those objects, then sweeps orphans: objects in
// comment-media older than an hour that no comment references.
//
// SAFETY: the orphan pass is destructive, so it refuses to run unless it
// could positively read the comments table, and it never deletes more than
// MAX_ORPHANS per run. If the referenced set can't be built, nothing is
// removed and the response says so.
//
// Auth: x-notify-secret (same secret the notify trigger uses).
// Deploy: supabase functions deploy media-sweep --no-verify-jwt

import { SUPABASE_URL, svcHeaders, db, json } from "../_shared/db.ts";

const NOTIFY_SECRET = Deno.env.get("NOTIFY_SECRET") ?? "";
const BUCKET = "comment-media";
const MAX_ORPHANS = 200;

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

// comment-media is <projectId>/<file>: list the top-level folders, then each.
async function listAll(): Promise<{ name: string; created_at: string }[]> {
  const list = async (prefix: string) => {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, {
      method: "POST",
      headers: svcHeaders(),
      body: JSON.stringify({ prefix, limit: 1000, offset: 0, sortBy: { column: "name", order: "asc" } }),
    });
    if (!res.ok) throw new Error(`list ${prefix || "/"}: ${res.status}`);
    return (await res.json()) as { name: string; id: string | null; created_at: string }[];
  };
  const out: { name: string; created_at: string }[] = [];
  for (const folder of await list("")) {
    if (folder.id !== null) continue; // a file at the root — leave it alone
    for (const f of await list(`${folder.name}/`)) {
      if (f.id !== null) out.push({ name: `${folder.name}/${f.name}`, created_at: f.created_at });
    }
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  if (!NOTIFY_SECRET || req.headers.get("x-notify-secret") !== NOTIFY_SECRET) return json(401, { error: "bad secret" });

  // 1. Tombstones (explicitly deleted comments).
  const tombs = await db<{ path: string }[]>(`attachment_tombstones?select=path&limit=1000`);
  const tombPaths = tombs.map((t) => t.path).filter(Boolean);
  const removedTombs = tombPaths.length ? await removeObjects(tombPaths) : 0;
  if (tombPaths.length) {
    for (const p of tombPaths) {
      await db(`attachment_tombstones?path=eq.${encodeURIComponent(p)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
    }
  }

  // 2. Orphans — only with a positively-built referenced set.
  let rows: { attachments: { url?: string }[] | null }[];
  try {
    rows = await db(`comments?select=attachments`);
  } catch (e) {
    console.error("orphan sweep skipped: could not read comments", e);
    return json(200, { tombstones: removedTombs, orphans: 0, skipped: "could not read comments" });
  }
  const referenced = new Set<string>();
  let withAttachments = 0;
  for (const r of rows) {
    for (const a of r.attachments ?? []) {
      const m = (a?.url ?? "").match(/\/comment-media\/(.+)$/);
      if (m) { referenced.add(decodeURIComponent(m[1])); withAttachments++; }
    }
  }
  const cutoff = Date.now() - 60 * 60 * 1000;
  const all = await listAll();
  // Refuse if the bucket has objects but we saw zero references at all —
  // that is far more likely a read problem than a bucket of pure orphans.
  if (all.length > 0 && referenced.size === 0) {
    return json(200, { tombstones: removedTombs, orphans: 0, skipped: "no references found; refusing to sweep" , objects: all.length });
  }
  const orphans = all
    .filter((o) => !referenced.has(o.name) && new Date(o.created_at).getTime() < cutoff)
    .map((o) => o.name)
    .slice(0, MAX_ORPHANS);
  const removedOrphans = orphans.length ? await removeObjects(orphans) : 0;

  return json(200, { tombstones: removedTombs, orphans: removedOrphans, referenced: referenced.size, objects: all.length });
});
