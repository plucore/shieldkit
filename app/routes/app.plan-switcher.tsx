/**
 * app/routes/app.plan-switcher.tsx
 * Route: /app/plan-switcher
 *
 * Under Shopify Managed Pricing, plan switching and cancellation are handled
 * on Shopify's hosted pricing page. This route is a thin redirect to the
 * merchant's managed-pricing URL on admin.shopify.com.
 *
 * Mandatory for App Store review: merchants must be able to view their plan,
 * switch plans, and cancel without contacting support. Managed pricing's
 * hosted page covers all three.
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
