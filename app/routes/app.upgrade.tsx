/**
 * app/routes/app.upgrade.tsx
 * Route: /app/upgrade
 *
 * Under Shopify Managed Pricing, the pick-a-plan UI is hosted by Shopify.
 * This route is a thin server-side redirect to the merchant's managed-pricing
 * URL on admin.shopify.com.
 *
 * The redirect is unconditional — even if the merchant is already on a paid
 * plan, the managed-pricing page handles the "you're already subscribed"
 * state natively (and supports plan switching from there). No need for a
 * separate switcher route.
 */

import { redirect, useRouteError } from "react-router";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getManagedPricingUrl } from "../lib/billing/plans";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = getManagedPricingUrl(session.shop);
  return redirect(url);
};

// ─── Boundaries ───────────────────────────────────────────────────────────────

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
