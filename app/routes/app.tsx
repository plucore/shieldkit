import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { NavMenu } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";
import { getManagedPricingUrl, hasPaidAccess } from "../lib/billing/plans";

// Mirrors the gate in app.gtin-fill.tsx. We hide the nav entry entirely when
// write_products has not yet been granted so paying merchants don't click
// through to a feature that can't run.
const WRITE_METAFIELDS_SCOPE_ENABLED =
  (process.env.SCOPES ?? "").includes("write_products");

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, redirect } = await authenticate.admin(request);

  // Load tier so NavMenu can hide paid-only links for free merchants and
  // recovery-only links for monitoring merchants. Single small read; avoids
  // exposing routes the merchant can't use.
  //
  // plan_selection_shown_at rides along on the same read — it gates the
  // one-time plan-picker redirect below and would otherwise cost a second
  // round trip on every /app/* navigation.
  const { data: merchantRow } = await supabase
    .from("merchants")
    .select("tier, plan_selection_shown_at")
    .eq("shopify_domain", session.shop)
    .maybeSingle();

  const tier = (merchantRow?.tier as string | undefined) ?? "free";

  // ── One-time plan selection redirect ──────────────────────────────────────
  //
  // Shopify App Pricing does NOT surface the plan picker on its own. Its docs
  // put the redirect on the app ("When merchants install your app or need to
  // select a plan, redirect them to this page"), and until this landed
  // ShieldKit never did it — so Shopify auto-enrolled every install on the
  // Free plan and the paid plan was reachable only via an in-app Upgrade
  // button. Months of Partner events are nothing but "Free - Free
  // subscription" activations: nobody declined Monitoring, nobody saw it.
  //
  // DELIBERATELY NOT the documented `billing.check()` gate. That pattern
  // redirects whenever there is no active payment, which for an app with a
  // real free tier bounces every free merchant to the picker on EVERY load and
  // makes the free tier unusable. (`billing.check()` is also unavailable here:
  // no `billing` config is registered, and it stopped reporting managed-pricing
  // status after 2026-04-28.) The picker is shown ONCE, then the merchant is
  // free to stay on Free.
  //
  // ORDERING IS LOAD-BEARING. Build the URL first, then stamp, then redirect:
  //   - getManagedPricingUrl throws when SHOPIFY_APP_HANDLE is unset, and this
  //     is the LAYOUT loader — an uncaught throw here takes out every /app/*
  //     route, not just this feature. Hence the try/catch.
  //   - Stamping BEFORE the redirect is what makes a redirect loop impossible.
  //     Worst case a merchant misses the picker once and can still reach it
  //     from Manage plan; a loop would lock them out of the app entirely.
  //   - A failed stamp means we must NOT redirect, for the same reason.
  if (merchantRow && !hasPaidAccess(tier) && merchantRow.plan_selection_shown_at == null) {
    let pricingUrl: string | null = null;
    try {
      pricingUrl = getManagedPricingUrl(session.shop);
    } catch (err) {
      console.error(
        `[app] Cannot build managed-pricing URL for ${session.shop} — skipping plan-selection redirect:`,
        err instanceof Error ? err.message : err,
      );
    }

    if (pricingUrl) {
      const { error: stampError } = await supabase
        .from("merchants")
        .update({ plan_selection_shown_at: new Date().toISOString() })
        .eq("shopify_domain", session.shop);

      if (stampError) {
        console.error(
          `[app] Failed to stamp plan_selection_shown_at for ${session.shop} — NOT redirecting (a loop would be worse than a missed picker): ${stampError.message}`,
        );
      } else {
        // target: "_top" escapes the embedded iframe. admin.shopify.com sends
        // X-Frame-Options: DENY, so a plain redirect renders nothing — the
        // same constraint app.upgrade.tsx works around with window.open.
        return redirect(pricingUrl, { target: "_top" });
      }
    }
  }

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
