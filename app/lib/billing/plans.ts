/**
 * app/lib/billing/plans.ts
 *
 * Single source of truth for ShieldKit v2 plan definitions.
 *
 * The `name` field is the canonical plan identifier passed to:
 *   - shopifyApp({ billing }) config keys in app/shopify.server.ts
 *   - billing.request({ plan }) / billing.cancel() in route loaders
 *   - app_subscription.name in APP_SUBSCRIPTIONS_UPDATE webhook payloads
 *
 * Changing a `name` here is a breaking change requiring `npm run deploy` to
 * re-register plans with Shopify and risks orphaning existing subscriptions.
 */
import { BillingInterval } from "@shopify/shopify-app-react-router/server";
import type { BillingConfigSubscriptionLineItemPlan } from "@shopify/shopify-api";

export const PLANS = {
  free: { name: "Free", monthly: 0, annual: 0 },
  shield_monthly: { name: "Shield", monthly: 14, interval: "EVERY_30_DAYS" },
  shield_annual: { name: "Shield Annual", annual: 140, interval: "ANNUAL" },
  pro_monthly: { name: "Shield Pro", monthly: 39, interval: "EVERY_30_DAYS" },
  pro_annual: { name: "Shield Pro Annual", annual: 390, interval: "ANNUAL" },
} as const;

export type PlanKey = keyof typeof PLANS;
export type PaidPlanKey = Exclude<PlanKey, "free">;
export type PlanName = (typeof PLANS)[PlanKey]["name"];
export type PaidPlanName = (typeof PLANS)[PaidPlanKey]["name"];

// ─── Derived: paid plan names (the strings Shopify knows about) ──────────────
export const PAID_PLAN_NAMES: readonly PaidPlanName[] = [
  PLANS.shield_monthly.name,
  PLANS.shield_annual.name,
  PLANS.pro_monthly.name,
  PLANS.pro_annual.name,
] as const;

// ─── Derived: plan name → merchants.tier value ───────────────────────────────
// Used by billing.confirm loader and APP_SUBSCRIPTIONS_UPDATE webhook.
export const PLAN_NAME_TO_TIER: Record<PlanName, "free" | "shield" | "pro"> = {
  Free: "free",
  Shield: "shield",
  "Shield Annual": "shield",
  "Shield Pro": "pro",
  "Shield Pro Annual": "pro",
};

// ─── Derived: plan name → billing_cycle column value ─────────────────────────
export const PLAN_NAME_TO_CYCLE: Record<PlanName, "monthly" | "annual" | null> = {
  Free: null,
  Shield: "monthly",
  "Shield Annual": "annual",
  "Shield Pro": "monthly",
  "Shield Pro Annual": "annual",
};

// ─── Shopify billing config (consumed by app/shopify.server.ts) ──────────────
// Subscription plans MUST use the `lineItems` shape per Shopify SDK types.
// Each paid plan becomes a key in shopifyApp({ billing }) so billing.check()
// and billing.request() accept these names as `keyof Config['billing']`.
function recurring(
  amount: number,
  interval: BillingInterval.Every30Days | BillingInterval.Annual,
): BillingConfigSubscriptionLineItemPlan {
  return {
    lineItems: [
      {
        amount,
        currencyCode: "USD",
        interval,
      },
    ],
  };
}

export const SHOPIFY_BILLING_CONFIG = {
  [PLANS.shield_monthly.name]: recurring(
    PLANS.shield_monthly.monthly,
    BillingInterval.Every30Days,
  ),
  [PLANS.shield_annual.name]: recurring(
    PLANS.shield_annual.annual,
    BillingInterval.Annual,
  ),
  [PLANS.pro_monthly.name]: recurring(
    PLANS.pro_monthly.monthly,
    BillingInterval.Every30Days,
  ),
  [PLANS.pro_annual.name]: recurring(
    PLANS.pro_annual.annual,
    BillingInterval.Annual,
  ),
} satisfies Record<PaidPlanName, BillingConfigSubscriptionLineItemPlan>;

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
    "Everything in Shield monthly",
    "16% off ($140/yr vs $168/yr)",
  ],
  pro_monthly: [
    "Everything in Shield",
    "Merchant Listings JSON-LD enricher",
    "GTIN / MPN / brand auto-filler",
    "Organization & WebSite schema (site-wide)",
    "llms.txt at root domain",
    "AI bot allow/block toggle",
  ],
  pro_annual: [
    "Everything in Shield Pro monthly",
    "16% off ($390/yr vs $468/yr)",
  ],
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
export function planKeyByName(name: string): PlanKey | null {
  for (const key of Object.keys(PLANS) as PlanKey[]) {
    if (PLANS[key].name === name) return key;
  }
  return null;
}
