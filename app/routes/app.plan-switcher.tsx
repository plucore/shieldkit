/**
 * app/routes/app.plan-switcher.tsx
 * Route: /app/plan-switcher
 *
 * Bridges from the embedded app iframe to Shopify Managed Pricing's hosted
 * page, where the merchant can view, switch, or cancel their plan.
 *
 * Same iframe-escape pattern as /app/upgrade — see that file's docstring
 * for why we can't use a server-side `redirect()` here.
 */

import { useEffect } from "react";
import { useLoaderData, useRouteError } from "react-router";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";
import { getManagedPricingUrl } from "../lib/billing/plans";
import { captureEvent } from "../lib/analytics.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  if (!session.shop) {
    throw new Error("authenticate.admin returned a session without a shop");
  }

  // Analytics: paywall_viewed (plan-switcher entry). Wrapped so neither the
  // tier read nor the capture can break the redirect to managed pricing.
  try {
    const { data: row } = await supabase
      .from("merchants")
      .select("tier")
      .eq("shopify_domain", session.shop)
      .maybeSingle();
    await captureEvent(session.shop, "paywall_viewed", {
      tier: row?.tier ?? "free",
      entry: "plan_switcher",
    });
  } catch (err) {
    console.warn(`[plan-switcher] paywall_viewed analytics failed for ${session.shop}:`, err);
  }

  return { url: getManagedPricingUrl(session.shop) };
};

export default function PlanSwitcher() {
  const { url } = useLoaderData<typeof loader>();

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.open(url, "_top");
  }, [url]);

  return (
    <s-page heading="Opening your plan page…">
      <s-section>
        <s-paragraph>
          Taking you to your ShieldKit plan on Shopify, where you can switch
          or cancel your plan…
        </s-paragraph>
        <s-paragraph>
          <a href={url} target="_top" rel="noreferrer">
            Click here if you aren't redirected automatically.
          </a>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

// ─── Boundaries ───────────────────────────────────────────────────────────────

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
