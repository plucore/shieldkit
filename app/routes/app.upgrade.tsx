/**
 * app/routes/app.upgrade.tsx
 * Route: /app/upgrade?plan=<Starter|Pro|Shield>
 *
 * Triggers the Shopify hosted billing-approval flow for the requested plan.
 * The loader validates the plan param, then calls billing.request() which
 * throws a redirect (Promise<never>) — the merchant is sent to Shopify's
 * subscription confirmation page.
 *
 * After the merchant approves (or declines), Shopify:
 *   1. Redirects the merchant back to returnUrl (/app)
 *   2. Fires APP_SUBSCRIPTIONS_UPDATE webhook → webhooks.app_subscriptions.update.tsx
 *
 * isTest is enabled outside production so test charges are used during
 * development (no real billing occurs).
 */

import { redirect } from "react-router";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  authenticate,
  PLANS,
  type PlanName,
} from "../shopify.server";

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { billing, session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const planParam = url.searchParams.get("plan");

  // Validate the plan exists in our billing config before calling Shopify
  if (!planParam || !(PLANS as readonly string[]).includes(planParam)) {
    console.warn(`[app.upgrade] Invalid plan "${planParam}" — redirecting to dashboard`);
    return redirect("/app");
  }

  const plan = planParam as PlanName;

  // billing.request() NEVER RETURNS — it throws a redirect to Shopify's
  // subscription approval page.  After approval OR cancellation, Shopify
  // sends the merchant back to returnUrl.
  //
  // We point returnUrl at /app/billing/confirm (our own route) so the loader
  // there can call billing.check(), write the correct tier to Supabase, and
  // *then* redirect to the dashboard — ensuring the dashboard loader always
  // reads the fresh tier value.
  //
  // Pattern: admin.shopify.com/store/{shop}/apps/{apiKey}/billing/confirm
  // maps to the /app/billing/confirm route inside the embedded context.
  const shopSubdomain = session.shop.replace(".myshopify.com", "");
  const embeddedReturnUrl =
    `https://admin.shopify.com/store/${shopSubdomain}/apps/` +
    `${process.env.SHOPIFY_API_KEY ?? ""}/billing/confirm`;

  await billing.request({
    // `plan` is PlanName ("Starter" | "Pro" | "Shield") which matches the
    // billing config keys exactly; cast to any to satisfy the strict generic.
    plan: plan as any,
    isTest: process.env.NODE_ENV !== "production",
    returnUrl: embeddedReturnUrl,
  });

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

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
