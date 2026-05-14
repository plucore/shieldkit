/**
 * app/lib/billing/plans.ts
 *
 * Plan reference data for ShieldKit v2 under Shopify Managed Pricing.
 *
 * Under managed pricing, Shopify hosts the pick-a-plan page; the canonical
 * plan definitions live in the Partner Dashboard listing UI. This module
 * keeps:
 *
 *   - Display-side plan data (PLANS, TIER_GROUPS, PLAN_FEATURES) so the app
 *     can show feature lists and prices in upsell cards without round-trips
 *     to Shopify.
 *   - Mapping data (PLAN_NAME_TO_TIER, PLAN_NAME_TO_GROUP) so the
 *     APP_SUBSCRIPTIONS_UPDATE webhook and the billing-confirm loader can
 *     translate Shopify's plan-name string into our DB tier. Cycle is
 *     derived from the AppPricingInterval enum (intervalToCycle) — not from
 *     the plan name — because under managed pricing's "monthly with yearly
 *     option" plan type, monthly and annual variants share one display name.
 *
 * The plan-name strings here MUST match the names you configured in the
 * Partner Dashboard pricing UI exactly — they are the keys both sides use
 * to identify a plan.
 *
 * Note on tiers: merchants.tier values stay 'free' | 'shield' | 'pro' even
 * though the marketing labels rebranded. tier is a DB-level identity, not a
 * marketing label.
 */

export const PLANS = {
  free: { name: "Free", monthly: 0, annual: 0 },
  shield_monthly: { name: "Shield Pro", monthly: 14, interval: "EVERY_30_DAYS" },
  shield_annual: { name: "Shield Pro Annual", annual: 140, interval: "ANNUAL" },
  pro_monthly: { name: "Shield Max", monthly: 39, interval: "EVERY_30_DAYS" },
  pro_annual: { name: "Shield Max Annual", annual: 390, interval: "ANNUAL" },
} as const;

export type PlanKey = keyof typeof PLANS;
export type PaidPlanKey = Exclude<PlanKey, "free">;
export type PlanName = (typeof PLANS)[PlanKey]["name"];
export type PaidPlanName = (typeof PLANS)[PaidPlanKey]["name"];

// ─── Derived: plan name → merchants.tier value ───────────────────────────────
// Used by billing.confirm loader and APP_SUBSCRIPTIONS_UPDATE webhook to
// translate the plan-name string Shopify hands us into a DB tier value.
export const PLAN_NAME_TO_TIER: Record<PlanName, "free" | "shield" | "pro"> = {
  Free: "free",
  "Shield Pro": "shield",
  "Shield Pro Annual": "shield",
  "Shield Max": "pro",
  "Shield Max Annual": "pro",
};

// ─── Cycle derivation from Shopify's `interval` field ───────────────────────
// Under Shopify Managed Pricing, a "monthly with yearly option" plan has ONE
// display name (e.g. "Shield Pro") that applies to both billing cycles.
// The cycle is conveyed by the AppPricingInterval enum:
//   - APP_SUBSCRIPTIONS_UPDATE webhook: payload.app_subscription.interval
//     (top-level field on the flat REST-shaped webhook payload)
//   - billing.check({ returnObject: true }): sub.lineItems[0].plan.pricingDetails.interval
// Deriving cycle from interval works under both Partner Dashboard configs:
//   - 4 separate plans (Shield Pro, Shield Pro Annual, etc.)
//   - 2 "monthly with yearly option" plans (Shield Pro, Shield Max)
// Mapping the plan name to a cycle, by contrast, only works for the first.
//
// Casing tolerance: the GraphQL `AppPricingInterval` enum uses upper-snake
// ("ANNUAL", "EVERY_30_DAYS"), but the REST-shaped webhook payload appears
// to send lowercase ("annual", "every_30_days") — the 2026-05-09 smoke test
// produced a webhook with `interval` set to a value that didn't match the
// strict GraphQL casing, leaving billing_cycle NULL in the DB. Normalize
// to upper-snake before comparing so both shapes work.
export type ShopifyAppPricingInterval = "EVERY_30_DAYS" | "ANNUAL" | string;

export function intervalToCycle(
  interval: ShopifyAppPricingInterval | null | undefined,
): "monthly" | "annual" | null {
  if (interval == null) return null;
  const normalized = String(interval).toUpperCase();
  if (normalized === "ANNUAL") return "annual";
  if (normalized === "EVERY_30_DAYS") return "monthly";
  return null;
}

// ─── Cycle derivation by plan name (Partner API path) ───────────────────────
// Partner API's `AppSubscription` object exposes no `interval` enum — only
// `id`, `name`, `amount`, `billingOn`, `test`. So when the Partner API is the
// source of truth (post April 28 2026), cycle must come from the plan name.
//
// This works *only* because all four plans are configured as distinct names
// in the Partner Dashboard (no "monthly with yearly option" merging here).
// Keep this map in sync with PLAN_NAME_TO_TIER. If a future plan ever shares
// a name across cycles, the Partner API path will be unable to disambiguate
// and `partner-api.server.ts` will need a different source for cycle.
export const PLAN_NAME_TO_CYCLE: Record<PlanName, "monthly" | "annual" | null> = {
  Free: null,
  "Shield Pro": "monthly",
  "Shield Pro Annual": "annual",
  "Shield Max": "monthly",
  "Shield Max Annual": "annual",
};

// ─── Feature lists for plan-switcher UI ──────────────────────────────────────
export const PLAN_FEATURES: Record<PlanKey, readonly string[]> = {
  free: [
    "1 compliance scan per month",
    "Fix instructions for top 3 findings",
    "JSON-LD theme extension",
  ],
  shield_monthly: [
    "Unlimited compliance scans",
    "Continuous weekly monitoring",
    "Weekly health digest email",
    "AI policy generator",
    "GMC re-review appeal letter generator",
    "Hidden fee detector",
    "Image hosting audit (dropshipper detection)",
  ],
  shield_annual: [
    "Everything in Shield Pro monthly",
    "16% off ($140/yr vs $168/yr)",
  ],
  pro_monthly: [
    "Everything in Shield Pro",
    "Merchant Listings JSON-LD enricher",
    "GTIN / MPN / brand auto-filler",
    "Organization & WebSite schema (site-wide)",
    "llms.txt at root domain",
    "AI bot allow/block toggle",
  ],
  pro_annual: [
    "Everything in Shield Max monthly",
    "16% off ($390/yr vs $468/yr)",
  ],
};

// ─── Tier groups: monthly / annual variants per brand tier ───────────────────
export type TierGroupKey = "shield" | "pro";

export const TIER_GROUPS: Record<
  TierGroupKey,
  {
    label: string;
    monthlyName: PaidPlanName;
    annualName: PaidPlanName;
    monthlyPrice: number;
    annualPrice: number;
  }
> = {
  shield: {
    label: PLANS.shield_monthly.name,
    monthlyName: PLANS.shield_monthly.name,
    annualName: PLANS.shield_annual.name,
    monthlyPrice: PLANS.shield_monthly.monthly,
    annualPrice: PLANS.shield_annual.annual,
  },
  pro: {
    label: PLANS.pro_monthly.name,
    monthlyName: PLANS.pro_monthly.name,
    annualName: PLANS.pro_annual.name,
    monthlyPrice: PLANS.pro_monthly.monthly,
    annualPrice: PLANS.pro_annual.annual,
  },
};

// Annual savings (monthly × 12 − annual) per tier — used for the savings badge.
export function annualSavings(group: TierGroupKey): number {
  const g = TIER_GROUPS[group];
  return g.monthlyPrice * 12 - g.annualPrice;
}

// Feature lists keyed by tier group (combined across cycles since we don't
// differentiate features by cycle).
export const TIER_FEATURES: Record<TierGroupKey, readonly string[]> = {
  shield: [
    "Unlimited compliance scans",
    "Continuous weekly monitoring",
    "Weekly health digest email",
    "AI policy generator",
    "GMC re-review appeal letter generator",
    "Hidden fee detector",
    "Image hosting audit (dropshipper detection)",
  ],
  pro: [
    "Everything in Shield Pro, plus:",
    "Merchant Listings JSON-LD enricher",
    "GTIN / MPN / brand auto-filler",
    "Organization & WebSite schema (site-wide)",
    "llms.txt at root domain",
    "AI bot allow/block toggle",
  ],
};

// Plan name → tier group for "current plan" detection.
export const PLAN_NAME_TO_GROUP: Record<PlanName, TierGroupKey | null> = {
  Free: null,
  "Shield Pro": "shield",
  "Shield Pro Annual": "shield",
  "Shield Max": "pro",
  "Shield Max Annual": "pro",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
export function planKeyByName(name: string): PlanKey | null {
  for (const key of Object.keys(PLANS) as PlanKey[]) {
    if (PLANS[key].name === name) return key;
  }
  return null;
}

// ─── Shopify Managed Pricing URL ─────────────────────────────────────────────
// Format: https://admin.shopify.com/store/{shop_subdomain}/charges/{handle}/pricing_plans
// The {handle} segment is the app's slug from the Partner Dashboard listing
// URL (e.g. "shieldkit-google-merchant-fix"), supplied via SHOPIFY_APP_HANDLE.
export const SHOPIFY_MANAGED_PRICING_URL_TEMPLATE =
  "https://admin.shopify.com/store/{shop}/charges/{handle}/pricing_plans";

/**
 * Build the merchant-facing managed-pricing URL for a given shop.
 *
 * Strips the `.myshopify.com` suffix from the shop domain (Shopify admin
 * uses just the subdomain in the path) and substitutes the app handle.
 *
 * Throws loudly if SHOPIFY_APP_HANDLE is unset — silent failure here would
 * produce a broken URL that 404s on Shopify, which is much harder to debug
 * than an explicit error at request time.
 */
export function getManagedPricingUrl(shopifyDomain: string): string {
  const handle = process.env.SHOPIFY_APP_HANDLE;
  if (!handle) {
    throw new Error(
      "SHOPIFY_APP_HANDLE is not set. Required for managed pricing redirects. " +
      "Set it in Vercel env to the app handle from the Partner Dashboard listing URL.",
    );
  }
  const subdomain = shopifyDomain.replace(/\.myshopify\.com$/, "");
  return SHOPIFY_MANAGED_PRICING_URL_TEMPLATE
    .replace("{shop}", subdomain)
    .replace("{handle}", handle);
}
