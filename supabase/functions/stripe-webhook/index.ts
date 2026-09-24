// PinPoint — Stripe webhook. THE ONLY WRITER of subscriptions.plan.
//
// Verifies the signature, dedupes by event id (billing_events), and for every
// subscription-affecting event re-fetches the subscription from Stripe
// (events are not delivered in order) before upserting our row.
//
// Status -> plan:
//   active, trialing                          -> plan of the price (pro | agency)
//   past_due                                  -> same, grace_until = period_end + 14d
//   canceled, unpaid, incomplete*, paused     -> free
//
// Deploy: supabase functions deploy stripe-webhook --no-verify-jwt
// Stripe endpoint: https://<ref>.supabase.co/functions/v1/stripe-webhook
// Events: checkout.session.completed, customer.subscription.created/updated/
//         deleted, invoice.paid, invoice.payment_failed

import { db, json } from "../_shared/db.ts";
import { getStripe, cryptoProvider, STRIPE_WEBHOOK_SECRET, planForPrice } from "../_shared/stripe.ts";

const GRACE_DAYS = 14;

// Paid statuses keep the plan the price belongs to (pro / agency); anything
// else is free. The price object is expanded on retrieve below.
function planFor(status: string, sub: any): "pro" | "agency" | "free" {
  if (!(status === "active" || status === "trialing" || status === "past_due")) return "free";
  return planForPrice(sub.items?.data?.[0]?.price);
}

async function resolveUserId(sub: any): Promise<string | null> {
  if (sub?.metadata?.user_id) return sub.metadata.user_id;
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
  if (customerId) {
    const rows = await db<any[]>(`subscriptions?stripe_customer_id=eq.${customerId}&select=user_id&limit=1`);
    if (rows[0]?.user_id) return rows[0].user_id;
    try {
      const c: any = await getStripe().customers.retrieve(customerId);
      if (c?.metadata?.user_id) return c.metadata.user_id;
    } catch (_) { /* fall through */ }
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  const sig = req.headers.get("stripe-signature") ?? "";
  const body = await req.text();
  let event: any;
  try {
    event = await getStripe().webhooks.constructEventAsync(body, sig, STRIPE_WEBHOOK_SECRET, undefined, cryptoProvider);
  } catch (e) {
    return json(400, { error: `signature: ${(e as Error).message}` });
  }

  // Dedupe.
  const seen = await db<any[]>(`billing_events?id=eq.${event.id}&select=id&limit=1`);
  if (seen.length) return json(200, { received: true, duplicate: true });

  const obj = event.data.object;
  let subscriptionId: string | undefined;
  switch (event.type) {
    case "checkout.session.completed":
      subscriptionId = typeof obj.subscription === "string" ? obj.subscription : obj.subscription?.id;
      break;
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      subscriptionId = obj.id;
      break;
    case "invoice.paid":
    case "invoice.payment_failed":
      subscriptionId = typeof obj.subscription === "string" ? obj.subscription
        : obj.subscription?.id ?? obj.parent?.subscription_details?.subscription;
      break;
    default:
      await db(`billing_events`, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ id: event.id, type: event.type }) });
      return json(200, { received: true, handled: false });
  }
  if (!subscriptionId) {
    await db(`billing_events`, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ id: event.id, type: event.type }) });
    return json(200, { received: true, handled: false, reason: "no subscription id" });
  }

  try {
    // Always re-fetch the truth.
    const sub: any = await getStripe().subscriptions.retrieve(subscriptionId, { expand: ["items.data.price.product"] });
    const userId = await resolveUserId(sub);
    if (!userId) {
      console.warn(`webhook ${event.id}: could not resolve user for subscription ${subscriptionId}`);
      await db(`billing_events`, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ id: event.id, type: event.type }) });
      return json(200, { received: true, handled: false, reason: "unresolved user" });
    }

    // Don't downgrade on a `deleted` for a subscription we no longer track
    // (customer re-subscribed and the old one was cancelled).
    if (event.type === "customer.subscription.deleted") {
      const cur = await db<any[]>(`subscriptions?user_id=eq.${userId}&select=stripe_subscription_id&limit=1`);
      const tracked = cur[0]?.stripe_subscription_id;
      if (tracked && tracked !== subscriptionId) {
        await db(`billing_events`, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ id: event.id, type: event.type }) });
        return json(200, { received: true, handled: false, reason: "stale subscription" });
      }
    }

    const periodEndUnix: number | undefined = sub.items?.data?.[0]?.current_period_end ?? sub.current_period_end;
    const periodEnd = periodEndUnix ? new Date(periodEndUnix * 1000) : null;
    const status: string = sub.status;
    const plan = planFor(status, sub);
    let graceUntil: Date | null = null;
    if (status === "past_due") {
      const base = periodEnd && periodEnd.getTime() > Date.now() ? periodEnd : new Date();
      graceUntil = new Date(base.getTime() + GRACE_DAYS * 86400 * 1000);
    }
    const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;

    await db(`subscriptions?on_conflict=user_id`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        user_id: userId,
        plan,
        status,
        current_period_end: periodEnd ? periodEnd.toISOString() : null,
        cancel_at_period_end: !!sub.cancel_at_period_end,
        grace_until: graceUntil ? graceUntil.toISOString() : null,
        stripe_customer_id: customerId ?? null,
        stripe_subscription_id: subscriptionId,
        updated_at: new Date().toISOString(),
      }),
    });
    // Ledger LAST so a failed write above is retried by Stripe.
    await db(`billing_events`, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ id: event.id, type: event.type }) });
    return json(200, { received: true, user_id: userId, plan, status });
  } catch (e) {
    console.error(`webhook ${event.id} failed:`, e);
    return json(500, { error: "processing failed" });   // Stripe retries
  }
});
