import { Links, Meta, Outlet, Scripts, ScrollRestoration, useLoaderData } from "react-router";

export const loader = async () => {
  return {
    gaId: process.env.GA_MEASUREMENT_ID || null,
    gscToken: process.env.GOOGLE_SITE_VERIFICATION || null,
  };
};

export default function App() {
  const { gaId, gscToken } = useLoaderData<typeof loader>();

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
