/**
 * app/routes/app.billing.confirm.tsx
 * Route: /app/billing/confirm
 *
 * Landing route after Shopify's hosted billing-approval page.
 * Shopify redirects the merchant here (via the embeddedReturnUrl set in
 * app.upgrade.tsx) whether they approved OR cancelled the subscription.
 *
 * The loader:
 *   1. Authenticates the session (validates the JWT / re-uses the offline token).
 *   2. Calls billing.check() to get the live subscription state from Shopify.
 *   3. If a paid plan is active → writes the correct tier to Supabase so every
 *      subsequent loader on this request cycle sees the updated value.
 *   4. Redirects to /app (dashboard) or /app?billing=cancelled on decline.
 *
 * This approach is synchronous — the DB write happens before the redirect, so
 * the dashboard loader always reads the fresh tier. The APP_SUBSCRIPTIONS_UPDATE
 * webhook still fires and acts as a reconciliation backstop.
 */

import { redirect } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { authenticate, PLAN_PRO, type PlanName } from "../shopify.server";
import { supabase } from "../supabase.server";

// Maps the billing-config plan name → merchants.tier column value.
// Must stay in sync with PLAN_TO_TIER in webhooks.app_subscriptions.update.tsx.
const PLAN_TO_TIER: Record<PlanName, string> = {
  Pro: "pro",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { billing, session } = await authenticate.admin(request);

  let billingCheck;
  try {
    billingCheck = await billing.check({
      plans: [PLAN_PRO],
      isTest: process.env.NODE_ENV !== "production",
      // returnObject: true gives us the full subscription object including name
      returnObject: true,
    });
  } catch (err) {
    // billing.check() can throw if no subscription exists at all — treat as
    // cancelled / declined and fall through to the free-tier redirect.
    console.warn("[billing/confirm] billing.check() threw — treating as no active plan:", err);
    billingCheck = { hasActivePayment: false, appSubscriptions: [] };
  }

  console.log(
    "[billing/confirm] shop:", session.shop,
    "| hasActivePayment:", billingCheck.hasActivePayment,
    "| subscriptions:", JSON.stringify(billingCheck.appSubscriptions ?? [])
  );

  if (billingCheck.hasActivePayment) {
    // Identify which plan is active and map it to the correct tier string.
    // appSubscriptions[0].name matches the billing config key ("Starter" / "Pro" / "Shield").
    const activeName = (billingCheck.appSubscriptions?.[0]?.name ?? "") as PlanName;
    const tier = PLAN_TO_TIER[activeName] ?? "pro"; // safe fallback

    const { error } = await supabase
      .from("merchants")
      .update({
        tier,
        scans_remaining: null, // null = unlimited on all paid plans
      })
      .eq("shopify_domain", session.shop);

    if (error) {
      console.error(
        `[billing/confirm] Supabase update FAILED for ${session.shop}:`,
        error.message
      );
    } else {
      console.log(
        `[billing/confirm] tier="${tier}" written for ${session.shop}`
      );
    }

    // Send to dashboard — loaders will now read the updated tier from Supabase.
    return redirect("/app");
  }

  // No active payment — merchant declined or closed the billing page.
  // Send back to dashboard with the cancelled param so the toast fires.
  return redirect("/app?billing=cancelled");
};
