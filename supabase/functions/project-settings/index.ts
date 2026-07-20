// Avalanche Markup — project settings sync bridge.
//
// Lets the WordPress plugin push per-project flags (currently the
// "open feedback" toggle) to Supabase WITHOUT a service-role key on the
// WP server. The plugin proves itself with the shared WP_AUTH_SECRET —
// the same pattern as wp-session and notify-sync — and this function
// applies the update with the service role it holds internally.
//
// POST { token, open_access }  header: x-wp-auth-secret
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WP_AUTH_SECRET = Deno.env.get("WP_AUTH_SECRET") ?? "";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const svc = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  if (!WP_AUTH_SECRET || req.headers.get("x-wp-auth-secret") !== WP_AUTH_SECRET) {
    return json(401, { error: "bad secret" });
  }

  let token = "", openAccess = false;
  try {
    const b = await req.json();
    token = (b.token || "").toString().trim();
    openAccess = b.open_access === true || b.open_access === "1";
  } catch {
    return json(400, { error: "bad payload" });
  }
  if (!token) return json(400, { error: "missing token" });

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/projects?token=eq.${encodeURIComponent(token)}`,
    {
      method: "PATCH",
      headers: { ...svc, Prefer: "return=representation" },
      body: JSON.stringify({ open_access: openAccess }),
    },
  );
  if (!res.ok) return json(502, { error: "update failed", detail: await res.text() });

  const rows = await res.json().catch(() => []);
  if (!rows?.length) return json(400, { error: "unknown project token" });

  return json(200, { open_access: openAccess });
});
