// Avalanche Markup — notify-list sync bridge.
//
// Lets the WordPress plugin's "Email notifications" field sync to Supabase
// WITHOUT a service-role key on the WP server. The plugin proves itself
// with the shared WP_AUTH_SECRET (same one the auto-sign-in bridge uses);
// this function then replaces the project's notify_recipients using the
// service role it holds internally.
//
// POST { token, emails: string[] }  header: x-wp-auth-secret
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

  let token = "", emails: string[] = [];
  try {
    const b = await req.json();
    token = (b.token || "").toString().trim();
    emails = Array.isArray(b.emails) ? b.emails : [];
  } catch {
    return json(400, { error: "bad payload" });
  }
  if (!token) return json(400, { error: "missing token" });

  // Resolve the project from its token.
  const projects = await fetch(
    `${SUPABASE_URL}/rest/v1/projects?token=eq.${encodeURIComponent(token)}&select=id`,
    { headers: svc },
  ).then((r) => r.json()).catch(() => []);
  const projectId = projects?.[0]?.id;
  if (!projectId) return json(400, { error: "unknown project token" });

  // Normalize + de-dupe the address list.
  const list = [...new Set(
    emails.map((e) => (e || "").toString().toLowerCase().trim())
      .filter((e) => e.includes("@")),
  )];

  // Replace this project's recipients wholesale.
  await fetch(
    `${SUPABASE_URL}/rest/v1/notify_recipients?project_id=eq.${projectId}`,
    { method: "DELETE", headers: { ...svc, Prefer: "return=minimal" } },
  );
  if (list.length) {
    const rows = list.map((email) => ({ project_id: projectId, email }));
    const ins = await fetch(`${SUPABASE_URL}/rest/v1/notify_recipients`, {
      method: "POST",
      headers: { ...svc, Prefer: "return=minimal" },
      body: JSON.stringify(rows),
    });
    if (!ins.ok) return json(502, { error: "insert failed", detail: await ins.text() });
  }

  return json(200, { synced: list.length });
});
