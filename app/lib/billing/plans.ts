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
    // $29.00 USD — VERIFIED against the Partner API on 2026-07-28. Every real
    // (test:false) Monitoring activation bills 29.0: cq3dar-gv 2026-07-07,
    // sex-eshop 2026-07-12, 9973f3-3 2026-07-25.
    // Price history: $30 (pre-v4) → $39 → $29. The $39 → $29 change happened
    // between 2026-06-17 (hbhkfy-gy @ 39.0) and 2026-07-07 (cq3dar-gv @ 29.0).
    // This constant previously read 49, which NEVER matched a real charge.
    monthly: 29,
    interval: "EVERY_30_DAYS",
  },
  // Retained as the annual-PRICE source ($390) + to reconcile pre-collapse
  // subscribers whose Partner API charge is still named "Monitoring Annual".
  // New annual subs arrive as name "Monitoring" + amount 390 → resolved via
  // cycleFromChargeAmount(). Do NOT treat this name as a live pickable plan.
  monitoring_annual: {
    name: "Monitoring Annual",
    // $290.00 USD — the ONLY annual charge that has ever existed in the Partner
    // API is ygxib5-9s @ 290.0 on 2026-05-18. This previously read 390, which
    // never matched a real charge and additionally collided with the
    // grandfathered Shield Max Annual price of 390.
    annual: 290,
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

/**
 * Multiple of the monthly price at or above which a charge is read as annual.
 *
 * Every plan ShieldKit has ever sold discounts annual to exactly 10x monthly
 * (29/290, 14/140, 39/390), so the real gap is 10x. 6x sits well clear of any
 * plausible monthly price while staying below any plausible annual one, which
 * is what makes the structural fallback below tolerant of the constants above
 * drifting out of date by up to 6x before it can misread a cycle.
 */
const ANNUAL_RATIO_THRESHOLD = 6;

export function cycleFromChargeAmount(
  tier: Tier | null | undefined,
  amount: number | null | undefined,
): "monthly" | "annual" | null {
  if (tier == null || amount == null || !Number.isFinite(amount)) return null;
  // A zero/negative charge carries no cycle information: free plans (including
  // Shopify's localised "Gratuit"/"Gratis"/… variants) and test charges bill 0.
  if (amount <= 0) return null;

  const prices = TIER_PRICE_POINTS[tier];
  if (!prices) return null;

  // ── 1. Exact match on a known price point — highest confidence ────────────
  // Annual first as a defensive tiebreak if the two ever coincide.
  if (prices.annual != null && amount === prices.annual) return "annual";
  if (prices.monthly != null && amount === prices.monthly) return "monthly";

  // ── 2. No exact match → decide STRUCTURALLY, never return null here ───────
  //
  // This branch exists because returning null on an unmatched amount is what
  // made this function useless in practice. The constants above were wrong for
  // the app's entire paid history (49/390 declared vs 29/290 actually charged),
  // so every real charge fell through to null, and the caller's
  // PLAN_NAME_TO_CYCLE fallback mapped the collapsed single "Monitoring" name
  // to "monthly" unconditionally — meaning an ANNUAL subscriber would have been
  // silently recorded as monthly. Nobody would have noticed.
  //
  // The structural test does not depend on the constants being current, only on
  // annual being much larger than monthly — which is true of any sane pricing
  // and survives promos, proration, FX and price rises.
  if (prices.monthly != null && prices.monthly > 0) {
    return amount >= prices.monthly * ANNUAL_RATIO_THRESHOLD
      ? "annual"
      : "monthly";
  }
  if (prices.annual != null && prices.annual > 0) {
    return amount >= prices.annual / ANNUAL_RATIO_THRESHOLD
      ? "annual"
      : "monthly";
  }
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
/**
 * The ONLY statuses that genuinely end an entitlement.
 *
 * ONE SET, TWO CALLERS, ON PURPOSE. This used to be duplicated:
 * `webhooks.app_subscriptions.update.tsx` compared against Shopify's webhook
 * status (uppercase) and `api.cron.reconcile-subscriptions.ts` against the
 * Partner API's mapped status (lowercase). PR #14 removed FROZEN from the webhook
 * copy and left it in the cron copy, so the two paths disagreed about the same
 * Shopify event for a day: the webhook correctly ignored a freeze while the daily
 * cron demoted on it. Exactly the drifted-copies failure in §11a of claude.md,
 * in the billing layer.
 *
 * FROZEN IS NOT TERMINAL AND MUST NOT BE ADDED. A freeze is RECOVERABLE —
 * Shopify freezes an app subscription when the shop itself is frozen or a payment
 * fails, and emits an unfreeze when it clears. Treating it as terminal
 * permanently stripped paying merchants:
 *   0yzffh-vw  FROZEN 2026-06-02, $39 Shield Max          — never unfrozen, demoted
 *   ygxib5-9s  FROZEN 2026-06-15, $290 Monitoring Annual  — never unfrozen, demoted
 *   sbnjen-ee  FROZEN 2026-06-08 → UNFROZEN 2026-06-12    — under-entitled 4 days
 * A frozen shop cannot use the app anyway, so leaving the entitlement in place
 * costs nothing and cannot be abused; wrongly revoking it costs a customer. Fail
 * toward access.
 *
 * There is no UNFROZEN status to handle: partner-api.server.ts maps
 * SUBSCRIPTION_CHARGE_UNFROZEN → "active", so a recovery re-entitles through the
 * ordinary active path.
 */
export const TERMINAL_SUBSCRIPTION_STATUSES: readonly string[] = [
  "cancelled",
  "expired",
  "declined",
];

/**
 * Case-insensitive so both callers can pass their own casing — Shopify's webhook
 * sends "CANCELLED", the Partner API mapping yields "cancelled".
 */
export function isTerminalSubscriptionStatus(
  status: string | null | undefined,
): boolean {
  if (!status) return false;
  return TERMINAL_SUBSCRIPTION_STATUSES.includes(status.toLowerCase());
}

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
  "Unlimited store scans, re-check anytime",
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
