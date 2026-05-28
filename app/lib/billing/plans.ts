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
 *                     full paid feature set via hasPaidAccess.
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
//
// v4 (2026-05-28): Recovery removed (folded into Monitoring as one paid
// tier). Monitoring price changed from $30/$290 to $49/$449. Legacy
// shield_*/pro_* entries kept so grandfathered subscriptions still
// reconcile through the PLAN_NAME maps below; the 2 live Shield Max
// merchants stay on their existing subscriptions.
export const PLANS = {
  free: { name: "Free", monthly: 0, annual: 0 },

  // Current offerings (the only two paid plans the Partner Dashboard
  // should advertise post-v4).
  monitoring_monthly: {
    name: "Monitoring",
    monthly: 49,
    interval: "EVERY_30_DAYS",
  },
  monitoring_annual: {
    name: "Monitoring Annual",
    annual: 449,
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
  // Current (v4 — single paid tier)
  Monitoring: "monitoring",
  "Monitoring Annual": "monitoring",
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
    // Current (v4)
    Monitoring: "monthly",
    "Monitoring Annual": "annual",
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

// ─── Tier-access helper (single paid gate) ──────────────────────────────────
// v4 (2026-05-28) collapsed Monitoring + Recovery into a single paid tier
// called Monitoring. Every paid feature is now unlocked by hasPaidAccess —
// there is no longer a per-feature subdivision between "monitoring-class"
// and "recovery-class". The legacy `recovery` and `pro` tier values still
// resolve to true so grandfathered subscriptions keep working.
//
// Access matrix:
//                    | hasPaidAccess
//   free             |    no
//   shield  (grand.) |    no  ← zero live rows; degrades to free-level
//   monitoring       |    YES
//   recovery (grand.)|    YES ← rolled into Monitoring under v4
//   pro     (grand.) |    YES ← 2 live Shield Max customers
//
// Call sites: every feature gate in the codebase should go through this
// helper — DO NOT compare merchants.tier to a literal string at call sites.
// That made the v2→v3 migration fragile (15+ touch points to keep in sync).
// The only remaining literal comparisons are sentinel "is this free or not"
// checks (e.g. upgrade-CTA placement) and webhook-payload validation.

/**
 * Returns true if the tier unlocks the full paid feature set: unlimited
 * on-demand scans, AI-written policies, GMC appeal letter generator,
 * bulk GTIN/MPN/brand fill, ongoing per-product enrichment, llms.txt,
 * AI bot allow/block toggle, Organization/WebSite JSON-LD theme blocks.
 */
export function hasPaidAccess(tier: string | null | undefined): boolean {
  return tier === "monitoring" || tier === "recovery" || tier === "pro";
}

/**
 * The set of DB tier values that resolve to paid access. Centralised so
 * cron queries and any tier-filter code agree on one list. Renamed from
 * MONITORING_TIERS in v4 for clarity — same set, the name change tracks
 * the single-paid-tier collapse.
 */
export const PAID_TIERS: readonly Tier[] = [
  "monitoring",
  "recovery",
  "pro",
] as const;

// ─── Internal display data (canonical paid feature list) ────────────────────
// These exports back any in-app plan display surface. The Shopify Managed
// Pricing hosted page is canonical for the actual pick-a-plan UI; these
// constants back the dashboard value-status card and any upsell copy that
// needs the same list to stay in sync.
//
// v4 collapsed Monitoring + Recovery into a single paid tier. The two
// feature lists were merged into one canonical paid list. Grandfathered
// shield_*/pro_* feature blocks were deleted — no UI surface renders them
// (they were dead aspirational copy for a plan-switcher route that hasn't
// returned), and the grandfathered customers don't see in-app feature
// lists tagged with their legacy tier name.

/**
 * The single source of truth for what ShieldKit's paid plan unlocks.
 * Render this in pricing cards, dashboard value-status boxes, upgrade
 * prompts, anywhere a feature list per plan needs to appear.
 */
export const PAID_FEATURES: readonly string[] = [
  "Unlimited on-demand scans",
  "AI-written store policies (refund, shipping, privacy, terms)",
  "GMC re-review appeal letter generator",
  "Product data fixes (GTIN / MPN / brand)",
  "Auto structured data for new products",
  "llms.txt for AI search",
  "AI crawler allow/block controls",
  "Store schema settings (logo, social, search)",
  "JSON-LD product schema extension",
] as const;

/**
 * Free-tier feature list. Free merchants get one scan and the same
 * theme extension; the rest is locked behind paid.
 */
export const FREE_FEATURES: readonly string[] = [
  "One free compliance scan",
  "Step-by-step fix instructions",
  "JSON-LD product schema extension",
] as const;

export type TierGroupKey = "monitoring";

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
  monitoring: {
    label: "Monitoring",
    monthlyName: PLANS.monitoring_monthly.name,
    annualName: PLANS.monitoring_annual.name,
    monthlyPrice: PLANS.monitoring_monthly.monthly,
    annualPrice: PLANS.monitoring_annual.annual,
  },
};

/** Annual savings vs 12× monthly. Used by pricing card "Save $X/yr" copy. */
export function annualSavings(group: TierGroupKey = "monitoring"): number {
  const g = TIER_GROUPS[group];
  return g.monthlyPrice * 12 - g.annualPrice;
}

// Plan name → tier group for "current plan" detection in upsell cards.
// v4 has one group ("monitoring") — every paid plan name (current +
// grandfathered) maps there.
export const PLAN_NAME_TO_GROUP: Record<PlanName, TierGroupKey | null> = {
  Free: null,
  Monitoring: "monitoring",
  "Monitoring Annual": "monitoring",
  // Grandfathered
  "Shield Pro": "monitoring",
  "Shield Pro Annual": "monitoring",
  "Shield Max": "monitoring",
  "Shield Max Annual": "monitoring",
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
