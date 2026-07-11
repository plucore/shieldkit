import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { NavMenu } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";
import { hasPaidAccess } from "../lib/billing/plans";

// Mirrors the gate in app.gtin-fill.tsx. We hide the nav entry entirely when
// write_products has not yet been granted so paying merchants don't click
// through to a feature that can't run.
const WRITE_METAFIELDS_SCOPE_ENABLED =
  (process.env.SCOPES ?? "").includes("write_products");

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  // Load tier so NavMenu can hide paid-only links for free merchants and
  // recovery-only links for monitoring merchants. Single small read; avoids
  // exposing routes the merchant can't use.
  const { data: merchantRow } = await supabase
    .from("merchants")
    .select("tier")
    .eq("shopify_domain", session.shop)
    .maybeSingle();

  const tier = (merchantRow?.tier as string | undefined) ?? "free";

  // eslint-disable-next-line no-undef
  return {
    // eslint-disable-next-line no-undef
    apiKey: process.env.SHOPIFY_API_KEY || "",
    tier,
    gtinFillEnabled: WRITE_METAFIELDS_SCOPE_ENABLED,
  };
};

export default function App() {
  const { apiKey, tier, gtinFillEnabled } = useLoaderData<typeof loader>();

  // v4 single paid gate — any non-free tier unlocks all paid nav links.
  // Includes grandfathered shield/pro/recovery rows.
  const isPaid = hasPaidAccess(tier);

  return (
    <AppProvider embedded apiKey={apiKey}>
      <NavMenu>
        <a href="/app" rel="home">Dashboard</a>
        {isPaid && <a href="/app/appeal-letter">Appeal letter</a>}
        {isPaid && <a href="/app/pro-settings">Brand details</a>}
        {isPaid && gtinFillEnabled && (
          <a href="/app/gtin-fill">Fix product IDs</a>
        )}
        {isPaid && <a href="/app/bots/toggle">AI access</a>}
        <a href="/app/plan-switcher">Manage plan</a>
      </NavMenu>

      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their
// headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
