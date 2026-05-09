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
import { getManagedPricingUrl } from "../lib/billing/plans";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  if (!session.shop) {
    throw new Error("authenticate.admin returned a session without a shop");
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
