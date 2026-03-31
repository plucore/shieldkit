/**
 * app/routes/app.upgrade.tsx
 * Route: /app/upgrade?plan=Pro
 *
 * Triggers the Shopify hosted billing-approval flow for the Pro plan.
 * The loader calls billing.request() which throws a redirect (Promise<never>)
 * — the merchant is sent to Shopify's subscription confirmation page.
 *
 * After the merchant approves (or declines), Shopify:
 *   1. Redirects the merchant back to returnUrl (/app/billing/confirm)
 *   2. Fires APP_SUBSCRIPTIONS_UPDATE webhook → webhooks.app_subscriptions.update.tsx
 *
 * isTest is enabled outside production so test charges are used during
 * development (no real billing occurs).
 */

import { redirect } from "react-router";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  authenticate,
  PLAN_PRO,
  type PlanName,
} from "../shopify.server";

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { billing, session } = await authenticate.admin(request);

  const plan: PlanName = "Pro";

  // ── Check for existing active subscription ───────────────────────────────
  // If the merchant already has an active Pro plan, skip billing.request()
  // and redirect straight to the dashboard.
  try {
    const check = await billing.check({
      plans: [PLAN_PRO],
      isTest: process.env.NODE_ENV !== "production",
      returnObject: true,
    });
    if (check.hasActivePayment) {
      return redirect("/app");
    }
  } catch (checkErr) {
    // billing.check() throws when no subscription exists — proceed to request a new one.
    console.error("[upgrade] billing.check() threw (expected if no subscription):", checkErr);
  }

  // ── Request billing ──────────────────────────────────────────────────────
  // billing.request() throws a redirect to Shopify's subscription approval
  // page. After approval or cancellation, Shopify sends the merchant back
  // to returnUrl. The Shopify library converts a relative app path into the
  // full embedded admin URL automatically.
  try {
    await billing.request({
      plan: plan as any,
      isTest: process.env.NODE_ENV !== "production",
      returnUrl: "/app/billing/confirm",
    });
  } catch (err) {
    // billing.request() throws a Response (redirect) on success — re-throw it
    if (err instanceof Response) throw err;
    console.error("[upgrade] billing.request() failed:", err);
    return redirect("/app?billing=error");
  }

  // Unreachable — billing.request() always redirects
  return null;
};

// ─── Fallback UI ──────────────────────────────────────────────────────────────
// Normally never rendered (the loader always redirects), but provides a safe
// landing page in case something goes wrong upstream.

export default function UpgradePage() {
  // If somehow the loader returns null we just redirect the user back
  useLoaderData<typeof loader>();

  return (
    <s-page heading="Redirecting to billing…">
      <s-section>
        <s-paragraph>
          You are being redirected to the Shopify billing page. If you are not
          redirected automatically,{" "}
          <s-link href="/app">return to the dashboard</s-link>.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
