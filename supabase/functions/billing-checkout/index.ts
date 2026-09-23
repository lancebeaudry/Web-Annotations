// PinPoint — start a Pro subscription (Stripe Checkout).
//
// POST, Authorization: Bearer <user JWT>. Creates or reuses the Stripe
// Customer for this user, then returns a Checkout Session URL. The plan is
// NEVER set here — only the webhook writes `subscriptions.plan`.
// Deploy: supabase functions deploy billing-checkout --no-verify-jwt
// (the caller is verified in-function; the gateway check would accept the
// bare anon key, which is exactly what we don't want).

import { db, json } from "../_shared/db.ts";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { requireUser } from "../_shared/auth.ts";
import { getStripe, STRIPE_PRICE_ID, DASHBOARD_URL, stripeConfigured } from "../_shared/stripe.ts";

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  const cors = corsHeaders(req);
  if (req.method !== "POST") return json(405, { error: "POST only" }, cors);
  if (!stripeConfigured()) return json(503, { error: "billing not configured" }, cors);

  const caller = await requireUser(req, cors);
  if (caller instanceof Response) return caller;

  const rows = await db<any[]>(`subscriptions?user_id=eq.${caller.id}&select=plan,status,stripe_customer_id&limit=1`);
  const sub = rows[0];
  if (sub && sub.plan === "pro" && ["active", "trialing", "past_due"].includes(sub.status)) {
    return json(409, { error: "already_subscribed" }, cors);
  }

  let customerId: string | undefined = sub?.stripe_customer_id ?? undefined;
  if (!customerId) {
    const customer = await getStripe().customers.create({ email: caller.email, metadata: { user_id: caller.id } });
    // merge-duplicates: if two tabs raced, keep whichever landed first.
    await db(`subscriptions?on_conflict=user_id`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ user_id: caller.id, stripe_customer_id: customer.id, plan: "free", status: "none" }),
    });
    const again = await db<any[]>(`subscriptions?user_id=eq.${caller.id}&select=stripe_customer_id&limit=1`);
    customerId = again[0]?.stripe_customer_id ?? customer.id;
  }

  const session = await getStripe().checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
    client_reference_id: caller.id,
    subscription_data: { metadata: { user_id: caller.id } },
    allow_promotion_codes: true,
    billing_address_collection: "auto",
    // Query string BEFORE the hash: the dashboard is hash-routed.
    success_url: `${DASHBOARD_URL}?checkout=success#/account`,
    cancel_url: `${DASHBOARD_URL}?checkout=cancel#/account`,
  });
  return json(200, { url: session.url }, cors);
});
