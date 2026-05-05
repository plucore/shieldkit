/**
 * app/routes/webhooks.app_subscriptions.update.tsx
 * Route: /webhooks/app_subscriptions/update
 *
 * Handles APP_SUBSCRIPTIONS_UPDATE webhooks fired by Shopify when a merchant's
 * app subscription status changes (ACTIVE, CANCELLED, EXPIRED, etc.).
 *
 * v2 — recurring billing.
 *
 * On ACTIVE: persist tier, billing_cycle, subscription_started_at,
 *            shopify_subscription_id, scans_remaining=NULL.
 * On CANCELLED / EXPIRED / DECLINED / FROZEN:
 *            reset to free tier — clear paid-plan billing fields and
 *            grant 1 fresh scan with reset_at=now().
 *
 * Plan name → tier mapping lives in app/lib/billing/plans.ts.
 */

import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";
import {
  PLAN_NAME_TO_TIER,
  PLAN_NAME_TO_CYCLE,
  type PlanName,
} from "../lib/billing/plans";

// Shape of the APP_SUBSCRIPTIONS_UPDATE webhook payload
interface AppSubscriptionPayload {
  app_subscription: {
    admin_graphql_api_id: string; // GraphQL gid stored as shopify_subscription_id
    name: string;
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
  const { admin_graphql_api_id, name, status, created_at } = app_subscription;

  // Ignore PENDING — fires before merchant has approved; nothing to persist.
  if (status === "PENDING") return new Response();

  if (status === "ACTIVE") {
    const tier = PLAN_NAME_TO_TIER[name as PlanName];
    const cycle = PLAN_NAME_TO_CYCLE[name as PlanName];

    if (!tier || tier === "free") {
      console.warn(
        `[${topic}] Unrecognised plan name "${name}" for ${shop} — no DB update`,
      );
      return new Response();
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
