// PinPoint — start or change a paid plan (Stripe Checkout / in-place update).
//
// POST { plan: "pro" | "agency", interval: "month" | "year" }
// Authorization: Bearer <user JWT>.
//   * No active subscription  -> returns a Checkout Session URL.
//   * Active subscription     -> swaps the price in place (prorated) and
//                                returns the dashboard URL; the webhook
//                                writes the new plan.
// The plan is NEVER set here — only the webhook writes `subscriptions.plan`.
// Deploy: supabase functions deploy billing-checkout --no-verify-jwt

import { db, json } from "../_shared/db.ts";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { requireUser } from "../_shared/auth.ts";
import { getStripe, priceFor, DASHBOARD_URL, stripeConfigured, type Plan, type Interval } from "../_shared/stripe.ts";

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  const cors = corsHeaders(req);
  if (req.method !== "POST") return json(405, { error: "POST only" }, cors);
  if (!stripeConfigured()) return json(503, { error: "billing not configured" }, cors);

  const caller = await requireUser(req, cors);
  if (caller instanceof Response) return caller;

  let body: any = {};
  try { body = await req.json(); } catch { /* empty body = default */ }
  const plan: Plan = body.plan === "agency" ? "agency" : "pro";
  const interval: Interval = body.interval === "month" ? "month" : "year";
  const price = priceFor(plan, interval);
  if (!price) return json(503, { error: `no price configured for ${plan}/${interval}` }, cors);

  const rows = await db<any[]>(`subscriptions?user_id=eq.${caller.id}&select=plan,status,stripe_customer_id,stripe_subscription_id&limit=1`);
  const sub = rows[0];
  const active = sub && sub.plan !== "free" && ["active", "trialing", "past_due"].includes(sub.status) && sub.stripe_subscription_id;

  if (active) {
    // Change plan or interval in place; Stripe prorates and the webhook follows.
    const current: any = await getStripe().subscriptions.retrieve(sub.stripe_subscription_id);
    const item = current.items?.data?.[0];
    if (!item) return json(409, { error: "subscription has no items" }, cors);
    if (item.price?.id === price) return json(409, { error: "already_subscribed" }, cors);
    await getStripe().subscriptions.update(sub.stripe_subscription_id, {
      items: [{ id: item.id, price }],
      proration_behavior: "create_prorations",
      cancel_at_period_end: false,
    });
    return json(200, { url: `${DASHBOARD_URL}?checkout=success#/account`, switched: true }, cors);
  }

  let customerId: string | undefined = sub?.stripe_customer_id ?? undefined;
  if (!customerId) {
    const customer = await getStripe().customers.create({ email: caller.email, metadata: { user_id: caller.id } });
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
    line_items: [{ price, quantity: 1 }],
    client_reference_id: caller.id,
    subscription_data: { metadata: { user_id: caller.id, plan } },
    allow_promotion_codes: true,
    billing_address_collection: "auto",
    success_url: `${DASHBOARD_URL}?checkout=success#/account`,
    cancel_url: `${DASHBOARD_URL}?checkout=cancel#/account`,
  });
  return json(200, { url: session.url }, cors);
});
