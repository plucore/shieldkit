import { useEffect } from "react";
import { Links, Meta, Outlet, Scripts, ScrollRestoration, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { initAnalytics } from "./lib/analytics.client";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // POSTHOG_API_KEY (phc_…) is a publishable client key — safe to expose to
  // the browser. The shop param is present on the embedded-admin document load
  // and is what we identify on. Both null on the public marketing site, where
  // analytics stays off.
  const shop = new URL(request.url).searchParams.get("shop");
  return {
    gaId: process.env.GA_MEASUREMENT_ID || null,
    gscToken: process.env.GOOGLE_SITE_VERIFICATION || null,
    posthogKey: process.env.POSTHOG_API_KEY || null,
    posthogHost: process.env.POSTHOG_HOST || null,
    shop,
  };
};

export default function App() {
  const { gaId, gscToken, posthogKey, posthogHost, shop } = useLoaderData<typeof loader>();

  // Init posthog-js once, guarded by the key. Only when a shop is present
  // (embedded admin app) — the public marketing site has no merchant to
  // identify and no client funnel events, so posthog-js never loads there.
  // initAnalytics is idempotent and self-guarding; the dashboard also inits
  // defensively in case this loader doesn't re-run on a client navigation.
  useEffect(() => {
    if (!shop) return;
    void initAnalytics({ apiKey: posthogKey, host: posthogHost, shopDomain: shop });
  }, [posthogKey, posthogHost, shop]);

  const gtagInit = gaId
    ? `window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', '${gaId}');`
    : null;

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="icon" type="image/x-icon" href="/favicon.ico" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        {gscToken ? (
          <meta name="google-site-verification" content={gscToken} />
        ) : null}
        {gaId ? (
          <>
            <script
              async
              src={`https://www.googletagmanager.com/gtag/js?id=${gaId}`}
            />
            <script dangerouslySetInnerHTML={{ __html: gtagInit! }} />
          </>
        ) : null}
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
