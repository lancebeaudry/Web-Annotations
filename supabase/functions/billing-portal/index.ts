// Avalanche Markup — Stripe Customer Portal (update card, cancel at period
// end, invoices). POST, Authorization: Bearer <user JWT>.
// Deploy: supabase functions deploy billing-portal --no-verify-jwt

import { db, json } from "../_shared/db.ts";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { requireUser } from "../_shared/auth.ts";
import { getStripe, DASHBOARD_URL, stripeConfigured } from "../_shared/stripe.ts";

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  const cors = corsHeaders(req);
  if (req.method !== "POST") return json(405, { error: "POST only" }, cors);
  if (!stripeConfigured()) return json(503, { error: "billing not configured" }, cors);

  const caller = await requireUser(req, cors);
  if (caller instanceof Response) return caller;

  const rows = await db<any[]>(`subscriptions?user_id=eq.${caller.id}&select=stripe_customer_id&limit=1`);
  const customerId = rows[0]?.stripe_customer_id;
  if (!customerId) return json(404, { error: "no_customer" }, cors);

  const session = await getStripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: `${DASHBOARD_URL}#/account`,
  });
  return json(200, { url: session.url }, cors);
});
