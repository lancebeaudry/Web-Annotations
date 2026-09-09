// Service-role PostgREST helper shared by the edge functions. Bypasses RLS —
// only use inside functions that have already authenticated the caller.

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
export const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

export const svcHeaders = (extra: Record<string, string> = {}) => ({
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
  ...extra,
});

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

// GET/POST/PATCH/DELETE against /rest/v1. Throws on non-2xx.
export async function db<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: svcHeaders((init.headers as Record<string, string>) ?? {}),
  });
  if (!res.ok) throw new Error(`db ${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}
