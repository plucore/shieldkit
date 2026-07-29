/**
 * app/routes/webhooks.app_subscriptions.update.tsx
 * Route: /webhooks/app_subscriptions/update
 *
 * ⚠️  STATUS: PRE-APRIL-28 SUPPLEMENTARY CHANNEL — NOT CANONICAL.
 *
 * Shopify is removing APP_SUBSCRIPTIONS_UPDATE webhooks for managed-pricing
 * apps on April 28, 2026. Until that date, this handler still fires and acts
 * as a reconciliation backstop so plan state stays correct even if the
 * /app/billing/confirm redirect is interrupted.
 *
 * POST-APRIL-28 the canonical reconciliation path is the Partner API:
 *   - /app/billing/confirm calls getActiveSubscriptionByChargeId() with the
 *     ?charge_id= URL param.
 *   - The /app loader (app._index.tsx) self-heals via the same Partner API
 *     call on every dashboard render.
 *   - Out-of-band status changes (cancellations from the merchant's billing
 *     page, freezes, etc.) need to be discovered via the Partner API events
 *     endpoint — see partner-api.server.ts getEventsByShopGid /
 *     getEventsByChargeId. A scheduled reconciliation job using those
 *     queries should be added before the April 28 cliff.
 *
 * After Shopify confirms the webhook is no longer delivered, this entire
 * file can be deleted along with the [[webhooks]] block in shopify.app.toml
 * that subscribes to app_subscriptions/update.
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
import { ensureProductWebhooks } from "../lib/webhooks/product-webhooks.server";
import { sentry } from "../lib/sentry.server";
import {
  PLAN_NAME_TO_TIER,
  intervalToCycle,
  type PlanName,
  type ShopifyAppPricingInterval,
  isTerminalSubscriptionStatus,
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

  // FROZEN is explicitly a no-op, not a fall-through. Leaving the entitlement
  // intact is deliberate (see TERMINAL_SUBSCRIPTION_STATUSES in plans.ts). When
  // the freeze clears,
  // Shopify redelivers this webhook with status=ACTIVE, so the ACTIVE branch
  // below re-entitles the merchant automatically — that is the UNFROZEN
  // handling. There is no "UNFROZEN" webhook status; UNFROZEN exists only as a
  // Partner API *event type*, which surfaces here as a plain ACTIVE.
  if (status === "FROZEN") {
    console.warn(
      `[${topic}] FROZEN for ${shop} sub=${admin_graphql_api_id} — entitlement intentionally LEFT INTACT (recoverable state, not a cancellation)`,
    );
    return new Response();
  }

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
      return new Response();
    }

    // Provision the per-shop products/* subscriptions IN THE SAME BREATH as the
    // entitlement. Until 2026-07-29 this branch wrote the paid tier and stopped,
    // leaving provisioning to the daily reconcile-subscriptions self-heal — a
    // window of up to 24h in which a merchant is paying and enrichment discovery
    // is dead. Wanok Cosmetics spent three days in the equivalent gap because the
    // daily cron had never actually run (the GET/POST bug), so the backstop it
    // relied on did not exist.
    //
    // Awaited, not fire-and-forget: the serverless container can freeze the moment
    // the response is returned, which would silently drop a `void` promise. It is
    // 2-3 Shopify calls (~1s) inside Shopify's webhook budget, and
    // ensureProductWebhooks never throws.
    try {
      const ensure = await ensureProductWebhooks(shop);
      if (ensure.errors.length) {
        console.warn(
          `[${topic}] ensureProductWebhooks errors for ${shop}: ${ensure.errors.join("; ")}`,
        );
      }
    } catch (err) {
      sentry.captureException(err, {
        tags: { area: "webhook.app_subscriptions", branch: "ensure_product_webhooks" },
        extra: { shop, tier },
      });
    }

    return new Response();
  }

  if (isTerminalSubscriptionStatus(status)) {
    // ── SUBSCRIPTION-IDENTITY GUARD (added 2026-07-28) ──────────────────────
    //
    // Only demote if this terminal event is for the subscription we are
    // ACTUALLY TRACKING. Without this check the handler demoted on a terminal
    // event for ANY subscription the shop had ever held.
    //
    // How that cost a real customer: Shopify Managed Pricing supersedes a plan
    // by cancelling the old subscription and activating the new one IN THE SAME
    // SECOND. Wanok Cosmetics (9973f3-3.myshopify.com), 2026-07-25:
    //   12:36:12  ACTIVATED  charge 67847061719  "Free"        0.00 USD
    //   12:39:20  ACTIVATED  charge 67847094487  "Monitoring"  29.00 USD  <- upgrade
    //   12:39:20  CANCELED   charge 67847061719  "Free"        0.00 USD   <- superseded
    // The CANCELED for the now-superseded FREE charge processed last and wiped
    // a live $29/mo entitlement at 12:39:22.64. Their Monitoring subscription
    // was never cancelled and is still active in Shopify today.
    //
    // A missing stored id is also NOT grounds to demote: if we are not tracking
    // a subscription there is nothing to cancel, and demoting on that basis is
    // what turns a stale event into data loss.
    const { data: row, error: readErr } = await supabase
      .from("merchants")
      .select("shopify_subscription_id, tier")
      .eq("shopify_domain", shop)
      .maybeSingle();

    if (readErr) {
      // Fail CLOSED: never demote on an unverified read. A missed demotion is
      // recoverable by the reconciler; a wrong demotion is a lost customer.
      console.error(
        `[${topic}] Could not read merchant for ${shop} — SKIPPING demote (fail-closed): ${readErr.message}`,
      );
      return new Response();
    }

    const stored = row?.shopify_subscription_id ?? null;
    if (!stored) {
      console.warn(
        `[${topic}] ${status} for ${shop} sub=${admin_graphql_api_id} but no tracked subscription id — NOT demoting.`,
      );
      return new Response();
    }
    if (stored !== admin_graphql_api_id) {
      console.warn(
        `[${topic}] ${status} for ${shop} is for sub=${admin_graphql_api_id} but we track sub=${stored} — SUPERSEDED/STALE event, NOT demoting.`,
      );
      return new Response();
    }

    const { error } = await supabase
      .from("merchants")
      .update({
        tier: "free",
        billing_cycle: null,
        subscription_started_at: null,
        // shopify_subscription_id is DELIBERATELY PRESERVED (2026-07-28).
        //
        // Nulling it erased the only key reconcile-subscriptions filters on
        // (`.not("shopify_subscription_id","is",null)`), so a wrongly-demoted
        // merchant became permanently invisible to the one job that could
        // restore them — the demote destroyed the key to its own recovery.
        // Keeping it lets the reconciler re-check the charge with the Partner
        // API and RE-PROMOTE if Shopify still says active. Retaining a charge
        // id on a free row is inert on its own: every feature gate reads
        // `tier` via hasPaidAccess(), never this column.
        scans_remaining: 1,
        scans_reset_at: new Date().toISOString(),
      })
      .eq("shopify_domain", shop);

    if (error) {
      console.error(
        `[${topic}] Failed to reset to free for ${shop} on status=${status}: ${error.message}`,
      );
    } else {
      // Every demotion in the 2026-07-28 incident was completely silent — the
      // only reason it was ever found was the founder reading the Partner
      // Dashboard by hand. A revoked entitlement is a revenue-affecting event
      // and should never be invisible again, even when it is correct.
      sentry.captureMessage(
        `Entitlement REVOKED for ${shop} — status=${status} sub=${admin_graphql_api_id} (was tier=${row?.tier})`,
        "warning",
      );
      console.log(
        `[${topic}] demoted ${shop} to free — status=${status} sub=${admin_graphql_api_id} (was tier=${row?.tier})`,
      );
    }
  }

  // Always return HTTP 200 so Shopify does not retry the delivery.
  return new Response();
};
