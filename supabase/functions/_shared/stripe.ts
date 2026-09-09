// Stripe client for Deno edge functions. Uses fetch (no Node http) and the
// SubtleCrypto provider for webhook signatures.
//
// Secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID,
//          DASHBOARD_URL, optional STRIPE_API_VERSION (pin once the account
//          exists; the SDK default is used otherwise).

import Stripe from "npm:stripe@17";

const key = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const apiVersion = Deno.env.get("STRIPE_API_VERSION");

export const stripe = new Stripe(key, {
  httpClient: Stripe.createFetchHttpClient(),
  ...(apiVersion ? { apiVersion: apiVersion as any } : {}),
});
export const cryptoProvider = Stripe.createSubtleCryptoProvider();
export const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
export const STRIPE_PRICE_ID = Deno.env.get("STRIPE_PRICE_ID") ?? "";
export const DASHBOARD_URL = (Deno.env.get("DASHBOARD_URL") ?? "").split(",")[0].trim();
export const stripeConfigured = () => !!(key && STRIPE_PRICE_ID && DASHBOARD_URL);
