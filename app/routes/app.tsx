import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { NavMenu } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  // Load tier so NavMenu can hide Shield Max-only links for free/shield merchants.
  // Single small read; avoids exposing pro-only routes to merchants who can't use them.
  const { data: merchantRow } = await supabase
    .from("merchants")
    .select("tier")
    .eq("shopify_domain", session.shop)
    .maybeSingle();

  const tier = (merchantRow?.tier as string | undefined) ?? "free";

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "", tier };
};

export default function App() {
  const { apiKey, tier } = useLoaderData<typeof loader>();
  const isShieldMax = tier === "pro";

  return (
    <AppProvider embedded apiKey={apiKey}>
      <NavMenu>
        <a href="/app" rel="home">Dashboard</a>
        <a href="/app/appeal-letter">Appeal letter</a>
        {isShieldMax && <a href="/app/pro-settings">Shield Max settings</a>}
        {isShieldMax && <a href="/app/gtin-fill">GTIN auto-filler</a>}
        {isShieldMax && <a href="/app/bots/toggle">AI bot access</a>}
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
