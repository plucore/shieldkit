/**
 * app/lib/billing/plans.ts
 *
 * Plan reference data and tier-access helpers for ShieldKit under Shopify
 * Managed Pricing (rebranded "Shopify App Pricing").
 *
 * v4 plan structure (effective 2026-05-28):
 *   - Free        — tier='free'        : 1 free compliance scan (one-time),
 *                                       fix instructions, JSON-LD theme
 *                                       extension. No monthly reset.
 *   - Monitoring  — tier='monitoring'  : single paid tier. Unlocks every
 *                                       paid feature — unlimited on-demand
 *                                       scans, AI policies, GMC appeal
 *                                       letter, bulk GTIN/MPN/brand fill,
 *                                       per-product enrichment on new
 *                                       products, llms.txt, AI bot
 *                                       allow/block, store schema settings,
 *                                       Organization & WebSite JSON-LD.
 *                                       Billed as "Monitoring" at $49/mo
 *                                       or $390/yr — annual is a discounted
 *                                       billing option on the single
 *                                       "Monitoring" plan since the 2026-06
 *                                       Partner Dashboard collapse.
 *
 * Grandfathered tiers (still in DB, still resolve through reconciliation,
 * NOT offered to new merchants):
 *   - tier='pro'      — "Shield Max" / "Shield Max Annual" — 2 live
 *                       customers on 2026-05-14. Resolve to full paid
 *                       access via hasPaidAccess.
 *   - tier='recovery' — pre-v4 Recovery plan. Zero live rows on
 *                       2026-05-28, but the tier value is kept valid in
 *                       the DB CHECK constraint and the helper so anything
 *                       that lands there still resolves as paid.
 *   - tier='shield'   — "Shield Pro" / "Shield Pro Annual" — zero live
 *                       rows, kept as a defensive back-stop. hasPaidAccess
 *                       returns false for shield-tier; if a row ever
 *                       appears it gracefully degrades to free-level
 *                       access (no premature downgrade — they just don't
 *                       gain the new gates without action).
 *
 * Source of truth for billing cycle:
 *   - Admin API webhook (pre-April-28 supplementary): the payload carries
 *     the real billing interval — use intervalToCycle().
 *   - Partner API path (post-April-28 canonical): AppSubscription exposes
 *     no `interval` field, BUT it does expose the charged `amount`. Since
 *     the 2026-06 dashboard collapse "Monitoring" monthly + annual share
 *     ONE plan name, so the name alone can no longer tell them apart —
 *     cycle is resolved from the amount via cycleFromChargeAmount(), with
 *     PLAN_NAME_TO_CYCLE only as a last-resort fallback for legacy
 *     distinct-named plans.
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
// tier). Monitoring price changed from $30/$290 to $49/$449.
// 2026-06: the standalone "Monitoring Annual" Partner Dashboard plan was
// deleted; annual is now a discounted billing option on the single
// "Monitoring" plan at $390/yr (was $449). The monitoring_annual entry is
// retained below as the canonical annual-PRICE source and to reconcile any
// pre-collapse subscriber whose charge is still named "Monitoring Annual".
// Legacy shield_*/pro_* entries kept so grandfathered subscriptions still
// reconcile through the PLAN_NAME maps below; the 2 live Shield Max
// merchants stay on their existing subscriptions.
export const PLANS = {
  free: { name: "Free", monthly: 0, annual: 0 },

  // Current offering: a single "Monitoring" plan billed monthly OR annually.
  // Annual is a discounted billing option on the same plan name since the
  // 2026-06 dashboard collapse — there is no separate "Monitoring Annual"
  // plan to pick anymore.
  monitoring_monthly: {
    name: "Monitoring",
    monthly: 49,
    interval: "EVERY_30_DAYS",
  },
  // Retained as the annual-PRICE source ($390) + to reconcile pre-collapse
  // subscribers whose Partner API charge is still named "Monitoring Annual".
  // New annual subs arrive as name "Monitoring" + amount 390 → resolved via
  // cycleFromChargeAmount(). Do NOT treat this name as a live pickable plan.
  monitoring_annual: {
    name: "Monitoring Annual",
    annual: 390,
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

// ─── Plan name → billing cycle (Partner API fallback only) ──────────────────
// The Partner API's `AppSubscription` exposes no `interval` enum. This map is
// now a LAST-RESORT fallback: since the 2026-06 collapse, "Monitoring" monthly
// and annual share one name, so the name can no longer distinguish their cycle
// — the Partner API path resolves cycle from the charge amount first (see
// cycleFromChargeAmount). This map still uniquely resolves every grandfathered
// distinct-named plan, and the legacy "Monitoring Annual" entry still correctly
// reconciles any pre-collapse annual subscriber.
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

// ─── cycleFromChargeAmount (Partner API path) ───────────────────────────────
// The Partner API's AppSubscription exposes NO `interval` field — only the
// charged `amount` (Money). Since the 2026-06 Partner Dashboard collapse,
// "Monitoring" monthly and "Monitoring" annual share ONE plan name, so the
// name alone can no longer distinguish their cycle. The charge amount can: a
// monthly subscription bills the monthly price, an annual one bills the
// (higher) annual price.
//
// Resolution is scoped to the tier (already resolved from the plan name) so
// the $390 figure — which is BOTH Monitoring-annual and the grandfathered
// Shield Max Annual, two *different* tiers — can never be misattributed.
//
// Returns null when the amount matches neither price point for the tier
// (foreign-currency charge, proration, discount, free/recovery tier with no
// price points). Callers then fall back to PLAN_NAME_TO_CYCLE and, failing
// that, write null — never a guessed cycle.
const TIER_PRICE_POINTS: Partial<
  Record<Tier, { monthly: number | null; annual: number | null }>
> = {
  monitoring: {
    monthly: PLANS.monitoring_monthly.monthly,
    annual: PLANS.monitoring_annual.annual,
  },
  pro: { monthly: PLANS.pro_monthly.monthly, annual: PLANS.pro_annual.annual },
  shield: {
    monthly: PLANS.shield_monthly.monthly,
    annual: PLANS.shield_annual.annual,
  },
};

export function cycleFromChargeAmount(
  tier: Tier | null | undefined,
  amount: number | null | undefined,
): "monthly" | "annual" | null {
  if (tier == null || amount == null || !Number.isFinite(amount)) return null;
  const prices = TIER_PRICE_POINTS[tier];
  if (!prices) return null;
  // Check annual first as a defensive tiebreak (no tier currently has equal
  // monthly/annual prices, but prefer the higher-value reading if that changes).
  if (prices.annual != null && amount === prices.annual) return "annual";
  if (prices.monthly != null && amount === prices.monthly) return "monthly";
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
  "Unlimited store scans — re-check anytime",
  "Store policies written for you (refund, shipping, privacy, terms)",
  "Appeal letters to help lift a Google suspension",
  "Auto-fill the product IDs Google requires",
  "New products auto-set-up to show well on Google",
  "Get found in AI answers (ChatGPT, Perplexity, Google AI)",
  "Choose which AI engines can read your store",
  "Add your logo and links so your brand shows correctly",
  "Show up better on Google",
] as const;

/**
 * Free-tier feature list. Free merchants get one scan and the same
 * theme extension; the rest is locked behind paid.
 */
export const FREE_FEATURES: readonly string[] = [
  "One free store scan",
  "Step-by-step fixes for what we find",
  "Show up better on Google",
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
