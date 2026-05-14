/**
 * app/routes/app.billing.confirm.tsx
 * Route: /app/billing/confirm
 *
 * Landing route after Shopify Managed Pricing's hosted approval page.
 * The founder configures this URL as the "Welcome link" in the Partner
 * Dashboard listing UI; Shopify redirects merchants here after they approve
 * (or cancel) a managed-pricing subscription, appending the new charge ID
 * as a `?charge_id={numeric}` query param.
 *
 * Primary path (post-April-28 canonical): query the Partner API for the
 * charge's most recent AppSubscriptionEvent, derive tier/cycle from plan
 * name, persist on "active".
 *
 * Legacy fallback (pre-April-28 only): billing.check() against the Admin
 * API. Shopify is removing this for managed-pricing apps on April 28, 2026
 * — after that date this fallback is dead code and should be deleted. The
 * APP_SUBSCRIPTIONS_UPDATE webhook is a separate reconciliation backstop
 * (see webhooks.app_subscriptions.update.tsx) that also expires April 28.
 *
 * On approval, persists to merchants:
 *   - tier                       (shield | pro)
 *   - billing_cycle              (monthly | annual)
 *   - subscription_started_at    (Partner API activatedAt, else now)
 *   - shopify_subscription_id    (GraphQL gid)
 *   - scans_remaining = NULL     (unlimited on paid plans)
 *
 * Fail-safe contract: when both the Partner API and billing.check() fail
 * or return ambiguous results, we DO NOT demote tier. We redirect to
 * /app?billing=error so the merchant ends up on the dashboard rather than
 * a blank page, and the founder can reconcile manually.
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
import {
  buildAppSubscriptionGid,
  getActiveSubscriptionByChargeId,
} from "../lib/billing/partner-api.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { billing, session } = await authenticate.admin(request);
  console.log(`[billing/confirm] loader entered for shop=${session.shop}`);

  // Shopify appends ?charge_id={numericId} to the welcome URL on approve.
  const url = new URL(request.url);
  const chargeIdParam = url.searchParams.get("charge_id");

  // ── Primary: Partner API ─────────────────────────────────────────────────
  if (chargeIdParam) {
    const chargeGid = buildAppSubscriptionGid(chargeIdParam);
    const sub = await getActiveSubscriptionByChargeId(chargeGid);
    console.log(
      `[billing/confirm] partner-api status=${sub.status} plan="${sub.planName}" tier=${sub.tier} cycle=${sub.cycle} reason=${sub.reason ?? ""}`,
    );

    if (sub.status === "active" && sub.tier && sub.tier !== "free") {
      const { error } = await supabase
        .from("merchants")
        .update({
          tier: sub.tier,
          billing_cycle: sub.cycle,
          subscription_started_at: sub.activatedAt ?? new Date().toISOString(),
          shopify_subscription_id: sub.subscriptionGid,
          scans_remaining: null,
        })
        .eq("shopify_domain", session.shop);

      if (error) {
        console.error(
          `[billing/confirm] Supabase update FAILED for ${session.shop}: ${error.message}`,
        );
      }
      return redirect("/app");
    }

    if (
      sub.status === "cancelled" ||
      sub.status === "declined" ||
      sub.status === "expired"
    ) {
      // Merchant declined or cancelled on the hosted page.
      return redirect("/app?billing=cancelled");
    }

    // status === "unknown" or "pending" or "frozen" — fall through to the
    // legacy billing.check() path. Never demote on uncertainty.
    console.warn(
      `[billing/confirm] partner-api inconclusive (status=${sub.status}); falling back to billing.check()`,
    );
  } else {
    console.warn(
      "[billing/confirm] no charge_id URL param; falling back to billing.check()",
    );
  }

  // ── Legacy fallback: billing.check() — REMOVE AFTER 2026-04-28 ───────────
  // Shopify stops returning subscription data via Admin billing.check() for
  // managed-pricing apps after April 28, 2026. This entire block is dead
  // code after that date and should be deleted then.
  let billingCheck;
  try {
    billingCheck = await billing.check({
      isTest: process.env.NODE_ENV !== "production",
      returnObject: true,
    });
    console.log(
      `[billing/confirm] LEGACY billing.check hasActivePayment=${billingCheck.hasActivePayment}`,
    );
  } catch (err) {
    console.warn(
      "[billing/confirm] LEGACY billing.check threw — treating as no active plan:",
      err,
    );
    billingCheck = { hasActivePayment: false, appSubscriptions: [] } as never;
  }

  if (billingCheck.hasActivePayment) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sub = billingCheck.appSubscriptions?.[0] as any;
    const activeName = (sub?.name ?? "") as PlanName;

    const tier = PLAN_NAME_TO_TIER[activeName];
    const interval = sub?.lineItems?.[0]?.plan?.pricingDetails?.interval;
    const cycle = intervalToCycle(interval);

    if (!tier || tier === "free") {
      console.error(
        `[billing/confirm] LEGACY active subscription "${activeName}" for ${session.shop} did not map to a paid tier`,
      );
      return redirect("/app?billing=error");
    }

    const subscriptionId = sub?.id ?? null;
    const startedAt = sub?.createdAt ?? new Date().toISOString();

    const { error } = await supabase
      .from("merchants")
      .update({
        tier,
        billing_cycle: cycle,
        subscription_started_at: startedAt,
        shopify_subscription_id: subscriptionId,
        scans_remaining: null,
      })
      .eq("shopify_domain", session.shop);

    if (error) {
      console.error(
        `[billing/confirm] LEGACY Supabase update FAILED for ${session.shop}: ${error.message}`,
      );
    }

    return redirect("/app");
  }

  return redirect("/app?billing=cancelled");
};
