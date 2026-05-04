/**
 * app/routes/app.billing.confirm.tsx
 * Route: /app/billing/confirm
 *
 * Landing route after Shopify's hosted billing-approval page.
 * Shopify redirects the merchant here (returnUrl set in app.upgrade.tsx)
 * whether they approved OR cancelled the subscription.
 *
 * v2 — recurring billing.
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
  PAID_PLAN_NAMES,
  PLAN_NAME_TO_TIER,
  PLAN_NAME_TO_CYCLE,
  type PlanName,
} from "../lib/billing/plans";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { billing, session } = await authenticate.admin(request);

  let billingCheck;
  try {
    billingCheck = await billing.check({
      plans: [...PAID_PLAN_NAMES],
      isTest: process.env.NODE_ENV !== "production",
      returnObject: true,
    });
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
    const cycle = PLAN_NAME_TO_CYCLE[activeName];

    if (!tier || tier === "free") {
      // Active payment but plan name doesn't map to a known paid tier —
      // shouldn't happen in practice but guard against billing config drift.
      console.error(
        `[billing/confirm] Active subscription "${activeName}" for ${session.shop} did not map to a paid tier`,
      );
      return redirect("/app?billing=error");
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
