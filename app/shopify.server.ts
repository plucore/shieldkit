import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { SupabaseSessionStorage } from "./lib/session-storage.server";
import { supabase } from "./supabase.server";
import { encrypt } from "./lib/crypto.server";
import { hasPaidAccess } from "./lib/billing/plans";
import { ensureProductWebhooks } from "./lib/webhooks/product-webhooks.server";
import { sentry } from "./lib/sentry.server";
import { captureEvent } from "./lib/analytics.server";

const sessionStorage = new SupabaseSessionStorage();

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October25,
  // Read from env if present (CLI injects at dev time), otherwise fall back
  // to the exact scopes declared in shopify.app.toml — read-only scanner.
  scopes: (process.env.SCOPES ?? "read_products,read_content,read_legal_policies").split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage,
  distribution: AppDistribution.AppStore,
  // Offline access tokens are intentionally LONG-LIVED — the
  // `expiringOfflineAccessTokens` future flag is deliberately OFF. ShieldKit is
  // background-heavy: scans, GTIN enrichment, llms.txt, webhook self-heal, and
  // the install/subscription reconcilers all call the Admin API from cron jobs
  // with no request context, so they CANNOT run the request-time token exchange
  // that refreshes an expiring offline token. With the flag on, every merchant's
  // background token died ~24h after install and never refreshed (merchants
  // rarely re-open the embedded app), 401'ing all background work. Long-lived
  // offline tokens are the correct fit; the refresh_token material is still
  // stored encrypted by SupabaseSessionStorage if request-time rotation is ever
  // reintroduced. Disabled 2026-06-26 after 42/43 installs went dark.
  // ─── Shopify Managed Pricing ─────────────────────────────────────────────
  // Plans are defined in the Partner Dashboard listing UI, not in code.
  // Merchants pick a plan on Shopify's hosted pricing page; we redirect them
  // there from /app/upgrade and /app/plan-switcher. APP_SUBSCRIPTIONS_UPDATE
  // webhooks still fire with the same payload shape (plan name + status).
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
  hooks: {
    afterAuth: async ({ session }) => {
      // afterAuth fires after every successful OAuth completion (install + re-auth).
      // Only process offline sessions — these are the persistent merchant sessions.
      // Online sessions (short-lived user sessions) do not represent an install.
      if (session.isOnline) return;

      // scans_remaining behavior on install:
      //   • First install (no prior row)      → INSERT with DB defaults,
      //                                          scans_remaining = 1 (free tier
      //                                          gets one starter scan).
      //   • Reinstall of soft-deleted row     → UPDATE only the 4 columns
      //                                          listed below; scans_remaining
      //                                          is preserved at whatever it
      //                                          was when the merchant
      //                                          uninstalled (typically 0 if
      //                                          they used their free scan).
      //   This is intentional — it prevents free-scan farming via
      //   uninstall→reinstall loops. A merchant who genuinely needs a fresh
      //   scan must upgrade. NEVER add scans_remaining to the upsert payload
      //   below without also gating it on "row didn't exist before" — adding
      //   it unconditionally would refund a free scan on every reauth, which
      //   is a paid-tier abuse path.
      const { error } = await supabase.from("merchants").upsert(
        {
          shopify_domain: session.shop,
          access_token_encrypted: session.accessToken
            ? encrypt(session.accessToken)
            : null,
          installed_at: new Date().toISOString(),
          uninstalled_at: null,
        },
        { onConflict: "shopify_domain" }
      );

      if (error) {
        console.error(
          `[afterAuth] Failed to upsert merchant for ${session.shop}:`,
          error.message
        );
      }

      // Analytics: funnel entry point (install). Over-firing on re-auth is
      // fine — funnels use the first occurrence per merchant. Awaited because
      // install is a one-time, non-latency-sensitive OAuth completion, so the
      // event flushes before the serverless function can freeze. captureEvent
      // is self-guarding: a no-op when POSTHOG_API_KEY is unset and never
      // throws, so OAuth completes identically whether PostHog is configured
      // or down. shopify_plan/country are not handy here (they'd need an Admin
      // API roundtrip and are null on first install), so they're omitted.
      await captureEvent(session.shop, "install");

      // Reinstall coverage: products/* webhooks are per-shop (not app-level)
      // and only provisioned for paid merchants. A reinstall of an existing
      // PAID merchant must re-assert those subscriptions, otherwise their
      // enrichment deliveries stay dark until the daily self-heal cron. Read
      // the current tier in a SEPARATE query — deliberately not folded into the
      // upsert payload above (the cleanup-batch §6 regression test guards that
      // payload against growth) — and gate via hasPaidAccess. Fire-and-forget:
      // OAuth completion must never block on an Admin API roundtrip, and the
      // reconcile-subscriptions cron is the durable backstop.
      void (async () => {
        try {
          const { data: row } = await supabase
            .from("merchants")
            .select("tier")
            .eq("shopify_domain", session.shop)
            .maybeSingle();
          if (hasPaidAccess(row?.tier)) {
            await ensureProductWebhooks(session.shop);
          }
        } catch (err) {
          sentry.captureException(err, {
            tags: { area: "afterAuth", branch: "ensure_product_webhooks" },
            extra: { shop: session.shop },
          });
        }
      })();
    },
  },
});

export default shopify;
export const apiVersion = ApiVersion.October25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export { sessionStorage };
