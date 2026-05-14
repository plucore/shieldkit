import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { NavMenu } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";
import {
  hasMonitoringAccess,
  hasRecoveryAccess,
} from "../lib/billing/plans";

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

  // Monitoring-gated links: Pro Settings, AI bot access. Available to
  // monitoring, recovery, and grandfathered pro (Shield Max).
  const showMonitoring = hasMonitoringAccess(tier);
  // Recovery-gated links: GMC appeal letter, bulk GTIN auto-filler. Available
  // to recovery and grandfathered pro only. Appeal letter is moving from
  // "available to everyone" to recovery-only as part of the v3 cutover.
  const showRecovery = hasRecoveryAccess(tier);

  return (
    <AppProvider embedded apiKey={apiKey}>
      <NavMenu>
        <a href="/app" rel="home">Dashboard</a>
        {showRecovery && <a href="/app/appeal-letter">Appeal letter</a>}
        {showMonitoring && <a href="/app/pro-settings">Pro settings</a>}
        {showRecovery && gtinFillEnabled && (
          <a href="/app/gtin-fill">GTIN auto-filler</a>
        )}
        {showMonitoring && <a href="/app/bots/toggle">AI bot access</a>}
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
