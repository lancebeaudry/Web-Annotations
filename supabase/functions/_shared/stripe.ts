// Stripe client for Deno edge functions. Uses fetch (no Node http) and the
// SubtleCrypto provider for webhook signatures.
//
// Construction is LAZY: the SDK throws if built with no key, and these
// functions must deploy and answer 503 cleanly before Stripe is configured.
//
// Secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, DASHBOARD_URL,
//          STRIPE_PRICE_PRO_MONTH / STRIPE_PRICE_PRO_YEAR /
//          STRIPE_PRICE_AGENCY_MONTH / STRIPE_PRICE_AGENCY_YEAR
//          (STRIPE_PRICE_ID = legacy alias for the Pro yearly price),
//          optional STRIPE_API_VERSION.

import Stripe from "npm:stripe@17";

const key = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const apiVersion = Deno.env.get("STRIPE_API_VERSION");
export const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
export const DASHBOARD_URL = (Deno.env.get("DASHBOARD_URL") ?? "").split(",")[0].trim();

export type Plan = "pro" | "agency";
export type Interval = "month" | "year";
export const PRICES: Record<Plan, Record<Interval, string>> = {
  pro: {
    month: Deno.env.get("STRIPE_PRICE_PRO_MONTH") ?? "",
    year: Deno.env.get("STRIPE_PRICE_PRO_YEAR") ?? Deno.env.get("STRIPE_PRICE_ID") ?? "",
  },
  agency: {
    month: Deno.env.get("STRIPE_PRICE_AGENCY_MONTH") ?? "",
    year: Deno.env.get("STRIPE_PRICE_AGENCY_YEAR") ?? "",
  },
};
export const STRIPE_PRICE_ID = PRICES.pro.year;

export const priceFor = (plan: Plan, interval: Interval): string => PRICES[plan]?.[interval] ?? "";
export const stripeConfigured = () => !!(key && PRICES.pro.year && DASHBOARD_URL);

// Which plan a Stripe price belongs to. Prices carry metadata.plan; fall back
// to the env map, then to Pro so a mis-tagged price never downgrades anyone.
export function planForPrice(price: any): Plan {
  const meta = price?.metadata?.plan ?? price?.product?.metadata?.plan;
  if (meta === "agency" || meta === "pro") return meta;
  const id = typeof price === "string" ? price : price?.id;
  for (const p of ["pro", "agency"] as Plan[]) for (const i of ["month", "year"] as Interval[]) if (PRICES[p][i] && PRICES[p][i] === id) return p;
  return "pro";
}

let client: Stripe | null = null;
export function getStripe(): Stripe {
  if (!client) {
    client = new Stripe(key, {
      httpClient: Stripe.createFetchHttpClient(),
      ...(apiVersion ? { apiVersion: apiVersion as any } : {}),
    });
  }
  return client;
}

export const cryptoProvider = Stripe.createSubtleCryptoProvider();
