// Resolve the calling user from their Supabase JWT — in the function, not
// at the gateway. The gateway's JWT check accepts the bare anon key; this
// does not. Rejects anonymous (guest) sessions, which have no email and
// must never reach billing.

import { createClient } from "npm:@supabase/supabase-js@2";
import { SUPABASE_URL, ANON_KEY, json } from "./db.ts";

export type Caller = { id: string; email: string };

export async function requireUser(req: Request, headers: Record<string, string> = {}): Promise<Caller | Response> {
  const authz = req.headers.get("authorization") ?? "";
  if (!authz.toLowerCase().startsWith("bearer ")) return json(401, { error: "sign in required" }, headers);
  const supa = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authz } } });
  const { data, error } = await supa.auth.getUser();
  const user = data?.user;
  if (error || !user || (user as any).is_anonymous || !user.email) {
    return json(401, { error: "sign in required" }, headers);
  }
  return { id: user.id, email: user.email };
}
