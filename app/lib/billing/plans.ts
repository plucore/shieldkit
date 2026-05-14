/**
 * app/lib/billing/plans.ts
 *
 * Plan reference data and tier-access helpers for ShieldKit under Shopify
 * Managed Pricing (rebranded "Shopify App Pricing").
 *
 * v3 plan structure (effective 2026-05-14):
 *   - Free        — tier='free'        : 1 scan/mo, score, fix instructions, JSON-LD.
 *   - Monitoring  — tier='monitoring'  : weekly scans, digest, JSON-LD, ongoing
 *                                       GTIN enrichment on new products, AI bot
 *                                       toggle, llms.txt, Pro Settings, AI-vis.
 *                                       Plans: "Monitoring" ($30/mo) and
 *                                       "Monitoring Annual" ($290/yr).
 *   - Recovery    — tier='recovery'    : Everything in Monitoring + GMC appeal
 *                                       letter generator, AI policy rewrites,
 *                                       bulk GTIN/MPN/brand fill on existing
 *                                       catalog, unlimited on-demand scans.
 *                                       Plan: "Recovery" ($150/yr annual only).
 *
 * Grandfathered tiers (still in DB, still resolve through reconciliation,
 * NOT offered to new merchants):
 *   - tier='pro'    — "Shield Max" / "Shield Max Annual" — 2 live customers
 *                     on 2026-05-14. Riding existing subscriptions until
 *                     June renewal. Has full access to BOTH monitoring and
 *                     recovery feature gates (hasMonitoringAccess +
 *                     hasRecoveryAccess both return true).
 *   - tier='shield' — "Shield Pro" / "Shield Pro Annual" — zero live rows,
 *                     kept in the plan/tier maps as a defensive back-stop.
 *                     The helpers below return false for shield-tier; if a
 *                     row ever appears it gracefully degrades to free-level
 *                     access (no premature downgrade — they just don't gain
 *                     the new gates without action).
 *
 * Source of truth for billing cycle: under the Partner API path (post-
 * April-28 canonical), AppSubscription has no `interval` field, so cycle
 * must come from the plan name via PLAN_NAME_TO_CYCLE. The Admin API
 * webhook (pre-April-28 supplementary) still uses intervalToCycle().
 */

// ─── Tier type ──────────────────────────────────────────────────────────────
// "shield" + "pro" are grandfathered; "monitoring" + "recovery" are current.
export type Tier = "free" | "shield" | "pro" | "monitoring" | "recovery";

// ─── PLANS ───────────────────────────────────────────────────────────────────
// Plan-name strings MUST match the names configured in the Partner Dashboard
// pricing UI exactly — they are the keys both sides use to identify a plan
// during webhook reconciliation and Partner API lookups.
export const PLANS = {
  free: { name: "Free", monthly: 0, annual: 0 },

  // Current offerings
  monitoring_monthly: {
    name: "Monitoring",
    monthly: 30,
    interval: "EVERY_30_DAYS",
  },
  monitoring_annual: {
    name: "Monitoring Annual",
    annual: 290,
    interval: "ANNUAL",
  },
  recovery_annual: {
    name: "Recovery",
    annual: 150,
    interval: "ANNUAL",
  },

  // Grandfathered — kept so existing subscriptions still reconcile through
  // PLAN_NAME_TO_TIER and PLAN_NAME_TO_CYCLE. Do not list these on the
  // pick-a-plan UI; new merchants must not see them.
  shield_monthly: { name: "Shield Pro", monthly: 14, interval: "EVERY_30_DAYS" },
  shield_annual: { name: "Shield Pro Annual", annual: 140, interval: "ANNUAL" },
  pro_monthly: { name: "Shield Max", monthly: 39, interval: "EVERY_30_DAYS" },
  pro_annual: { name: "Shield Max Annual", annual: 390, interval: "ANNUAL" },
} as const;

export type PlanKey = keyof typeof PLANS;
export type PaidPlanKey = Exclude<PlanKey, "free">;
export type PlanName = (typeof PLANS)[PlanKey]["name"];
export type PaidPlanName = (typeof PLANS)[PaidPlanKey]["name"];

// ─── Plan name → DB tier ────────────────────────────────────────────────────
// Used by webhook + Partner API reconciliation to translate the plan-name
// string Shopify hands us into a DB tier value.
//
// Grandfathered "Shield Pro" / "Shield Pro Annual" still map to 'shield', and
// "Shield Max" / "Shield Max Annual" still map to 'pro' — the 2 live paying
// customers on 2026-05-14 are on Shield Max and MUST continue to resolve
// correctly through this map. Do not remove the grandfathered entries.
export const PLAN_NAME_TO_TIER: Record<PlanName, Tier> = {
  Free: "free",
  // Current
  Monitoring: "monitoring",
  "Monitoring Annual": "monitoring",
  Recovery: "recovery",
  // Grandfathered
  "Shield Pro": "shield",
  "Shield Pro Annual": "shield",
  "Shield Max": "pro",
  "Shield Max Annual": "pro",
};

// ─── Plan name → billing cycle (Partner API path) ───────────────────────────
// Partner API's `AppSubscription` exposes no `interval` enum — cycle must
// come from the plan name. Works because all paid plan names are distinct.
export const PLAN_NAME_TO_CYCLE: Record<PlanName, "monthly" | "annual" | null> =
  {
    Free: null,
    // Current
    Monitoring: "monthly",
    "Monitoring Annual": "annual",
    Recovery: "annual",
    // Grandfathered
    "Shield Pro": "monthly",
    "Shield Pro Annual": "annual",
    "Shield Max": "monthly",
    "Shield Max Annual": "annual",
  };

// ─── intervalToCycle (Admin API / webhook path) ─────────────────────────────
// Used by APP_SUBSCRIPTIONS_UPDATE webhook (pre-April-28 supplementary
// channel) and the legacy billing.check() fallback. Casing-tolerant because
// some webhook payloads have arrived in lowercase ("annual") rather than
// the GraphQL enum's upper-snake ("ANNUAL").
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

// ─── Tier-access helpers (centralised feature gates) ────────────────────────
// Every feature gate in the codebase should go through one of these two
// helpers — DO NOT compare merchants.tier to a literal string at call sites.
// That made the v2→v3 migration fragile (15+ touch points to keep in sync).
//
// Access matrix:
//                    | monitoring gate | recovery gate
//   free             |       no        |      no
//   shield  (grand.) |       no        |      no
//   monitoring       |      YES        |      no
//   recovery         |      YES        |     YES
//   pro     (grand.) |      YES        |     YES   ← 2 live Shield Max custs.
//
// "Pro passes both" preserves the full feature set the 2 grandfathered
// Shield Max customers paid for. They must lose nothing on the v3 cutover.

/**
 * Returns true if the tier has access to recurring monitoring features:
 * weekly automated scans, weekly digest emails, ongoing GTIN enrichment
 * on newly-created products, AI bot allow/block, llms.txt, Pro Settings,
 * AI-visibility tracking.
 */
export function hasMonitoringAccess(tier: string | null | undefined): boolean {
  return tier === "monitoring" || tier === "recovery" || tier === "pro";
}

/**
 * Returns true if the tier has access to acute "recovery" features:
 * GMC re-review appeal letter generator, AI policy rewrites, bulk
 * GTIN/MPN/brand fill on the existing catalog, unlimited on-demand scans.
 *
 * NOTE the GTIN split: this gates *bulk* fill on the existing catalog.
 * *Ongoing* enrichment on newly-created products (via the products webhook)
 * is gated by hasMonitoringAccess instead.
 */
export function hasRecoveryAccess(tier: string | null | undefined): boolean {
  return tier === "recovery" || tier === "pro";
}

/**
 * The set of DB tier values that should receive the weekly cron pipeline
 * (scan + digest). Centralised so the cron queries and webhook scan
 * triggers all agree on the same list.
 */
export const MONITORING_TIERS: readonly Tier[] = [
  "monitoring",
  "recovery",
  "pro",
] as const;

// ─── Internal display data (not consumed by routes today) ───────────────────
// These exports back the in-app plan-switcher UI when/if it returns. The
// Shopify Managed Pricing hosted page is canonical today; keeping these in
// sync with PLANS so nothing drifts.

export const PLAN_FEATURES: Record<PlanKey, readonly string[]> = {
  free: [
    "1 compliance scan per month",
    "Fix instructions for top findings",
    "JSON-LD theme extension",
  ],
  monitoring_monthly: [
    "Weekly automated compliance scans",
    "Weekly health digest email",
    "AI bot allow/block toggle",
    "llms.txt at root domain",
    "Ongoing GTIN enrichment on new products",
    "AI-visibility tracking",
  ],
  monitoring_annual: [
    "Everything in Monitoring",
    "Best value — $290/yr vs $360/yr",
  ],
  recovery_annual: [
    "Everything in Monitoring, plus:",
    "GMC re-review appeal letter generator",
    "AI policy rewrites",
    "Bulk GTIN/MPN/brand fill on existing catalog",
    "Unlimited on-demand compliance scans",
  ],
  // Grandfathered — kept for completeness, not displayed to new merchants.
  shield_monthly: [
    "Unlimited compliance scans",
    "Continuous weekly monitoring",
    "Weekly health digest email",
    "AI policy generator",
    "GMC re-review appeal letter generator",
    "Hidden fee detector",
    "Image hosting audit (dropshipper detection)",
  ],
  shield_annual: ["Everything in Shield Pro monthly", "16% off"],
  pro_monthly: [
    "Everything in Shield Pro",
    "Merchant Listings JSON-LD enricher",
    "GTIN / MPN / brand auto-filler",
    "Organization & WebSite schema (site-wide)",
    "llms.txt at root domain",
    "AI bot allow/block toggle",
  ],
  pro_annual: ["Everything in Shield Max monthly", "16% off"],
};

export type TierGroupKey = "monitoring" | "recovery";

export const TIER_GROUPS: Record<
  TierGroupKey,
  {
    label: string;
    monthlyName: PaidPlanName | null;
    annualName: PaidPlanName;
    monthlyPrice: number | null;
    annualPrice: number;
  }
> = {
  monitoring: {
    label: "Monitoring",
    monthlyName: PLANS.monitoring_monthly.name,
    annualName: PLANS.monitoring_annual.name,
    monthlyPrice: PLANS.monitoring_monthly.monthly,
    annualPrice: PLANS.monitoring_annual.annual,
  },
  recovery: {
    label: "Recovery",
    monthlyName: null, // Recovery is annual-only on v3.
    annualName: PLANS.recovery_annual.name,
    monthlyPrice: null,
    annualPrice: PLANS.recovery_annual.annual,
  },
};

export function annualSavings(group: TierGroupKey): number | null {
  const g = TIER_GROUPS[group];
  if (g.monthlyPrice == null) return null;
  return g.monthlyPrice * 12 - g.annualPrice;
}

export const TIER_FEATURES: Record<TierGroupKey, readonly string[]> = {
  monitoring: [
    "Weekly automated compliance scans",
    "Weekly health digest email",
    "AI bot allow/block toggle",
    "llms.txt at root domain",
    "Ongoing GTIN enrichment on new products",
    "AI-visibility tracking",
  ],
  recovery: [
    "Everything in Monitoring, plus:",
    "GMC re-review appeal letter generator",
    "AI policy rewrites",
    "Bulk GTIN/MPN/brand fill on existing catalog",
    "Unlimited on-demand compliance scans",
  ],
};

// Plan name → tier group for "current plan" detection in upsell cards.
// Grandfathered Shield Max maps to recovery group (their feature set most
// closely matches recovery + monitoring combined). Grandfathered Shield Pro
// maps to monitoring (its feature set is closest to current monitoring).
// No live shield rows exist on 2026-05-14, so this is purely defensive.
export const PLAN_NAME_TO_GROUP: Record<PlanName, TierGroupKey | null> = {
  Free: null,
  Monitoring: "monitoring",
  "Monitoring Annual": "monitoring",
  Recovery: "recovery",
  // Grandfathered
  "Shield Pro": "monitoring",
  "Shield Pro Annual": "monitoring",
  "Shield Max": "recovery",
  "Shield Max Annual": "recovery",
};

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
// The pick-a-plan page itself is hosted by Shopify; this URL doesn't encode
// any plan structure, so v3 pricing rolls out without changing this builder.
export const SHOPIFY_MANAGED_PRICING_URL_TEMPLATE =
  "https://admin.shopify.com/store/{shop}/charges/{handle}/pricing_plans";

export function getManagedPricingUrl(shopifyDomain: string): string {
  const handle = process.env.SHOPIFY_APP_HANDLE;
  if (!handle) {
    throw new Error(
      "SHOPIFY_APP_HANDLE is not set. Required for managed pricing redirects. " +
        "Set it in Vercel env to the app handle from the Partner Dashboard listing URL.",
    );
  }
  const subdomain = shopifyDomain.replace(/\.myshopify\.com$/, "");
  return SHOPIFY_MANAGED_PRICING_URL_TEMPLATE.replace(
    "{shop}",
    subdomain,
  ).replace("{handle}", handle);
}
