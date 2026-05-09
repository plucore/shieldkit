/**
 * app/routes/webhooks.app_subscriptions.update.tsx
 * Route: /webhooks/app_subscriptions/update
 *
 * Handles APP_SUBSCRIPTIONS_UPDATE webhooks fired by Shopify when a merchant's
 * app subscription status changes (ACTIVE, CANCELLED, EXPIRED, etc.).
 *
 * Under Shopify Managed Pricing, the webhook payload is FLAT (REST-shaped):
 *   - `name`        → plan display name; same for both cycles when configured
 *                     as a "monthly with yearly option" plan in the Partner
 *                     Dashboard. Maps to merchants.tier via PLAN_NAME_TO_TIER.
 *   - `interval`    → "EVERY_30_DAYS" | "ANNUAL" — the source of truth for
 *                     billing_cycle. Do NOT derive cycle from the name.
 *   - `plan_handle` → Shopify-generated handle, distinct per cycle.
 *
 * On ACTIVE: persist tier, billing_cycle, subscription_started_at,
 *            shopify_subscription_id, scans_remaining=NULL.
 * On CANCELLED / EXPIRED / DECLINED / FROZEN:
 *            reset to free tier — clear paid-plan billing fields and
 *            grant 1 fresh scan with reset_at=now().
 */

import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";
import {
  PLAN_NAME_TO_TIER,
  intervalToCycle,
  type PlanName,
  type ShopifyAppPricingInterval,
} from "../lib/billing/plans";

// Shape of the APP_SUBSCRIPTIONS_UPDATE webhook payload (flat REST shape).
interface AppSubscriptionPayload {
  app_subscription: {
    admin_graphql_api_id: string; // GraphQL gid stored as shopify_subscription_id
    name: string;
    interval?: ShopifyAppPricingInterval; // "EVERY_30_DAYS" | "ANNUAL"
    plan_handle?: string;
    price?: string;
    status:
      | "ACTIVE"
      | "DECLINED"
      | "PENDING"
      | "CANCELLED"
      | "FROZEN"
      | "EXPIRED";
    created_at: string;
    updated_at: string;
    currency: string;
  };
}

const TERMINAL_STATUSES = new Set([
  "CANCELLED",
  "EXPIRED",
  "DECLINED",
  "FROZEN",
]);

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, topic, shop } = await authenticate.webhook(request);

  const { app_subscription } = payload as unknown as AppSubscriptionPayload;
  const { admin_graphql_api_id, name, status, created_at, interval } =
    app_subscription;

  // Log raw payload field shape so future smoke-test failures can be
  // diagnosed without a redeploy. Vercel's table view truncates long lines,
  // so log each field on its own.
  console.log(`[${topic}] shop=${shop} status=${status} name=${JSON.stringify(name)}`);
  console.log(`[${topic}] raw interval=${JSON.stringify(interval)} (typeof=${typeof interval})`);

  // Ignore PENDING — fires before merchant has approved; nothing to persist.
  if (status === "PENDING") return new Response();

  if (status === "ACTIVE") {
    const tier = PLAN_NAME_TO_TIER[name as PlanName];
    const cycle = intervalToCycle(interval);

    if (!tier || tier === "free") {
      console.warn(
        `[${topic}] Unrecognised plan name "${name}" for ${shop} — no DB update`,
      );
      return new Response();
    }

    if (!cycle) {
      console.warn(
        `[${topic}] Missing or unrecognised interval "${interval}" for plan "${name}" on ${shop} — billing_cycle will be NULL`,
      );
    }

    const { error } = await supabase
      .from("merchants")
      .update({
        tier,
        billing_cycle: cycle,
        shopify_subscription_id: admin_graphql_api_id,
        subscription_started_at: created_at,
        scans_remaining: null, // null = unlimited on all paid plans
      })
      .eq("shopify_domain", shop);

    if (error) {
      console.error(
        `[${topic}] Failed to activate plan "${name}" for ${shop}: ${error.message}`,
      );
    }

    return new Response();
  }

  if (TERMINAL_STATUSES.has(status)) {
    const { error } = await supabase
      .from("merchants")
      .update({
        tier: "free",
        billing_cycle: null,
        subscription_started_at: null,
        shopify_subscription_id: null,
        scans_remaining: 1,
        scans_reset_at: new Date().toISOString(),
      })
      .eq("shopify_domain", shop);

    if (error) {
      console.error(
        `[${topic}] Failed to reset to free for ${shop} on status=${status}: ${error.message}`,
      );
    }
  }

  // Always return HTTP 200 so Shopify does not retry the delivery.
  return new Response();
};
