/**
 * app/routes/app.upgrade.tsx
 * Route: /app/upgrade
 *
 * Bridges from the embedded app iframe to Shopify Managed Pricing's hosted
 * page on admin.shopify.com.
 *
 * Why this isn't a server-side `redirect()`:
 *   React Router 7's single-fetch translates a loader-returned redirect
 *   into a 202 with the URL in the body. The client follows it via
 *   `window.location.assign`, which navigates the IFRAME — and Shopify
 *   admin sends X-Frame-Options: DENY, so the iframe can't load the
 *   managed-pricing page. The merchant sees nothing.
 *
 *   Instead, the loader returns the URL as data and the component
 *   `window.open(url, "_top")`s on mount, breaking out of the iframe.
 */

import { useEffect } from "react";
import {
  useLoaderData,
  useRouteError,
} from "react-router";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";
import { getManagedPricingUrl } from "../lib/billing/plans";
import { captureEvent } from "../lib/analytics.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  if (!session.shop) {
    // Should never happen — the SDK guarantees session.shop on a successful
    // admin auth. Defensive guard keeps the failure mode visible.
    throw new Error("authenticate.admin returned a session without a shop");
  }

  // Analytics: paywall_viewed. Wrapped so neither the tier read nor the
  // capture can break the paywall redirect — this path must behave identically
  // if PostHog is down.
  try {
    const { data: row } = await supabase
      .from("merchants")
      .select("tier")
      .eq("shopify_domain", session.shop)
      .maybeSingle();
    await captureEvent(session.shop, "paywall_viewed", {
      tier: row?.tier ?? "free",
      entry: "upgrade",
    });
  } catch (err) {
    console.warn(`[upgrade] paywall_viewed analytics failed for ${session.shop}:`, err);
  }

  return { url: getManagedPricingUrl(session.shop) };
};

export default function Upgrade() {
  const { url } = useLoaderData<typeof loader>();

  useEffect(() => {
    if (typeof window === "undefined") return;
    // `_top` breaks out of the embedded-app iframe to the parent Shopify
    // admin window. Required because admin.shopify.com refuses iframe
    // embedding (X-Frame-Options: DENY).
    window.open(url, "_top");
  }, [url]);

  return (
    <s-page heading="Opening your plan page…">
      <s-section>
        <s-paragraph>
          Taking you to your ShieldKit plan on Shopify…
        </s-paragraph>
        <s-paragraph>
          {/* Manual fallback if the auto-redirect was blocked by a popup
              blocker or a stale App Bridge session. target="_top" ensures
              the click escapes the iframe. */}
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
