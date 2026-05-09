/**
 * app/routes/app.billing.confirm.tsx
 * Route: /app/billing/confirm
 *
 * Landing route after Shopify Managed Pricing's hosted approval page.
 * The founder configures this URL as the "Welcome link" in the Partner
 * Dashboard listing UI; Shopify redirects merchants here after they approve
 * (or cancel) a managed-pricing subscription.
 *
 * On approval, persists to merchants:
 *   - tier                       (shield | pro)
 *   - billing_cycle              (monthly | annual)
 *   - subscription_started_at    (now)
 *   - shopify_subscription_id    (GraphQL gid from Shopify)
 *   - scans_remaining = NULL     (unlimited on paid plans)
 *
 * The APP_SUBSCRIPTIONS_UPDATE webhook still fires and acts as a
 * reconciliation backstop — both writers must stay consistent.
 */

import { redirect } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";
import {
  PLAN_NAME_TO_TIER,
  intervalToCycle,
  type PlanName,
} from "../lib/billing/plans";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { billing, session } = await authenticate.admin(request);
  console.log(`[billing/confirm] loader entered for shop=${session.shop}`);

  let billingCheck;
  try {
    // Under managed pricing, billing.check() returns active subscriptions
    // without needing the `plans` argument — the plan list lives in Shopify.
    billingCheck = await billing.check({
      isTest: process.env.NODE_ENV !== "production",
      returnObject: true,
    });
    console.log(
      `[billing/confirm] billing.check hasActivePayment=${billingCheck.hasActivePayment}`,
      billingCheck.hasActivePayment
        ? `activePlan="${billingCheck.appSubscriptions?.[0]?.name}" subId="${(billingCheck.appSubscriptions?.[0] as any)?.id}"`
        : "",
    );
  } catch (err) {
    // billing.check() can throw if no subscription exists at all — treat as
    // cancelled / declined and fall through to the free-tier redirect.
    console.warn(
      "[billing/confirm] billing.check threw — treating as no active plan:",
      err,
    );
    billingCheck = { hasActivePayment: false, appSubscriptions: [] } as any;
  }

  if (billingCheck.hasActivePayment) {
    const sub = billingCheck.appSubscriptions?.[0];
    const activeName = (sub?.name ?? "") as PlanName;

    const tier = PLAN_NAME_TO_TIER[activeName];
    // GraphQL AppSubscription nests cycle under lineItems[].plan.pricingDetails.
    // Under managed pricing the "name" can be shared between cycles, so cycle
    // MUST come from the interval enum, not the plan name.
    const lineItems = (sub as any)?.lineItems;
    const interval = lineItems?.[0]?.plan?.pricingDetails?.interval;
    const cycle = intervalToCycle(interval);

    // Log raw shape for diagnosis — see equivalent block in webhook handler.
    console.log(
      `[billing/confirm] raw interval=${JSON.stringify(interval)} (typeof=${typeof interval})`,
    );
    console.log(
      `[billing/confirm] lineItems shape=${JSON.stringify(lineItems)}`,
    );

    if (!tier || tier === "free") {
      // Active payment but plan name doesn't map to a known paid tier —
      // shouldn't happen in practice but guard against billing config drift.
      console.error(
        `[billing/confirm] Active subscription "${activeName}" for ${session.shop} did not map to a paid tier`,
      );
      return redirect("/app?billing=error");
    }

    if (!cycle) {
      console.warn(
        `[billing/confirm] Missing/unknown interval "${interval}" for plan "${activeName}" on ${session.shop} — billing_cycle will be NULL`,
      );
    }

    const subscriptionId = (sub as any)?.id ?? null;
    // Prefer Shopify's authoritative createdAt; fall back to now() if absent.
    const startedAt =
      (sub as any)?.createdAt ?? new Date().toISOString();

    const { error } = await supabase
      .from("merchants")
      .update({
        tier,
        billing_cycle: cycle,
        subscription_started_at: startedAt,
        shopify_subscription_id: subscriptionId,
        scans_remaining: null, // null = unlimited on all paid plans
      })
      .eq("shopify_domain", session.shop);

    if (error) {
      console.error(
        `[billing/confirm] Supabase update FAILED for ${session.shop}:`,
        error.message,
      );
    }

    return redirect("/app");
  }

  // No active payment — merchant declined or closed the billing page.
  return redirect("/app?billing=cancelled");
};
