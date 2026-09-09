// CORS for functions called from the customer dashboard (a browser page on
// another origin). The overlay never calls these directly.

const ALLOWED = (Deno.env.get("DASHBOARD_URL") ?? "")
  .split(",")
  .map((u) => {
    try { return new URL(u.trim()).origin; } catch { return ""; }
  })
  .filter(Boolean);

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allow = ALLOWED.length === 0 || ALLOWED.includes(origin) ? origin : ALLOWED[0];
  return {
    "Access-Control-Allow-Origin": allow || "*",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

export function preflight(req: Request): Response | null {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  return null;
}
