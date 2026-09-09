// WordPress -> backend bridge authentication, PER PROJECT.
//
// A plugin proves it speaks for a site by presenting that project's own
// bridge secret (header x-avmk-project-secret) alongside the project token.
// Before 2.0 every site shared ONE global secret, so a leak from any one
// customer server could act on every project. Now a leaked secret is scoped
// to its project and can be rotated from the dashboard.
//
// Transitional: while sites are still on 1.9.x plugins, LEGACY_WP_AUTH_SECRET
// (the old global value) is accepted via the old x-wp-auth-secret header and
// logged as `legacy-secret-used` with the token, so it is visible which sites
// have not updated. Unset the env var once the log goes quiet.

import { db } from "./db.ts";

const LEGACY = Deno.env.get("LEGACY_WP_AUTH_SECRET") ?? "";

export type BridgeProject = { id: string; owner_id: string; name: string; site_url: string; open_access: boolean };

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Resolve the project for `token` if the request carries a valid secret for
// it. Returns null on any failure (unknown token, bad/missing secret).
export async function resolveProjectBySecret(req: Request, token: string): Promise<BridgeProject | null> {
  if (!token) return null;
  const rows = await db<BridgeProject[]>(
    `projects?token=eq.${encodeURIComponent(token)}&select=id,owner_id,name,site_url,open_access&limit=1`,
  );
  const project = rows[0];
  if (!project) return null;

  const presented = req.headers.get("x-avmk-project-secret") ?? "";
  if (presented) {
    const sec = await db<{ bridge_secret: string }[]>(
      `project_secrets?project_id=eq.${project.id}&select=bridge_secret&limit=1`,
    );
    const expected = sec[0]?.bridge_secret ?? "";
    if (expected && timingSafeEqual(presented, expected)) return project;
    return null;
  }

  const legacy = req.headers.get("x-wp-auth-secret") ?? "";
  if (LEGACY && legacy && timingSafeEqual(legacy, LEGACY)) {
    console.warn(`legacy-secret-used token=${token} project=${project.id}`);
    return project;
  }
  return null;
}
