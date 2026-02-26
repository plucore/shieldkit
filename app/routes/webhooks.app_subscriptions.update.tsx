/**
 * app/routes/webhooks.app_subscriptions.update.tsx
 * Route: /webhooks/app_subscriptions/update
 *
 * Handles APP_SUBSCRIPTIONS_UPDATE webhooks fired by Shopify when a merchant's
 * app subscription status changes (ACTIVE, CANCELLED, EXPIRED, etc.).
 *
 * ─── DB migration required ────────────────────────────────────────────────────
 * The merchants.tier CHECK constraint from the initial migration only includes
 * ('free', 'pro', 'unlimited'). Run the following in Supabase SQL editor to
 * expand it to cover all three plan tiers before going live:
 *
 *   ALTER TABLE merchants
 *     DROP CONSTRAINT IF EXISTS merchants_tier_check;
 *   ALTER TABLE merchants
 *     ADD CONSTRAINT merchants_tier_check
 *       CHECK (tier IN ('free', 'starter', 'pro', 'shield'));
 *
 * ─── Webhook registration ─────────────────────────────────────────────────────
 * Register this endpoint in the Shopify Partner Dashboard → App → Webhooks:
 *   Topic:  App subscriptions / Update
 *   URL:    https://<your-app-url>/webhooks/app_subscriptions/update
 *
 * The subscription name in the payload will exactly match the plan keys
 * defined in shopify.server.ts (PLAN_STARTER = "Starter", etc.).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { ActionFunctionArgs } from "react-router";
import { authenticate, PLANS, type PlanName } from "../shopify.server";
import { supabase } from "../supabase.server";

// Shape of the APP_SUBSCRIPTIONS_UPDATE webhook payload
interface AppSubscriptionPayload {
  app_subscription: {
    admin_graphql_api_id: string;
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
    trial_days: number;
  };
}

// Map plan name (from billing config) → merchants.tier column value
const PLAN_TO_TIER: Record<PlanName, string> = {
  Starter: "starter",
  Pro:     "pro",
  Shield:  "shield",
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, topic, shop } = await authenticate.webhook(request);

  console.log(`[${topic}] Received for ${shop}`);

  const { app_subscription } = payload as unknown as AppSubscriptionPayload;
  const { name, status } = app_subscription;

  if (status === "ACTIVE") {
    // ── Merchant approved a plan ────────────────────────────────────────────
    const tier = PLAN_TO_TIER[name as PlanName];

    if (!tier) {
      // Plan name doesn't match our billing config — log and ignore safely
      console.warn(
        `[${topic}] Unrecognised plan name "${name}" for ${shop} — no DB update`
      );
      return new Response();
    }

    const { error } = await supabase
      .from("merchants")
      .update({
        tier,
        scans_remaining: null, // null = unlimited on all paid plans
      })
      .eq("shopify_domain", shop);

    if (error) {
      console.error(
        `[${topic}] Failed to activate plan "${name}" for ${shop}: ${error.message}`
      );
    } else {
      console.log(
        `[${topic}] Plan activated — shop=${shop}, plan=${name}, tier=${tier}`
      );
    }
  } else if (
    status === "CANCELLED" ||
    status === "EXPIRED"   ||
    status === "DECLINED"  ||
    status === "FROZEN"
  ) {
    // ── Subscription ended — downgrade to free tier ─────────────────────────
    // scans_remaining → 0 because the merchant already used their one free
    // scan at install time.  They must re-subscribe to run more scans.
    const { error } = await supabase
      .from("merchants")
      .update({
        tier:             "free",
        scans_remaining:  0,
      })
      .eq("shopify_domain", shop);

    if (error) {
      console.error(
        `[${topic}] Failed to downgrade ${shop} to free tier after ` +
        `status=${status}: ${error.message}`
      );
    } else {
      console.log(
        `[${topic}] Downgraded to free tier — shop=${shop}, status=${status}`
      );
    }
  } else {
    // PENDING — subscription is awaiting merchant approval; no DB action needed
    console.log(
      `[${topic}] No DB action for status="${status}" — shop=${shop}`
    );
  }

  // Always return HTTP 200 so Shopify does not retry the delivery
  return new Response();
};
