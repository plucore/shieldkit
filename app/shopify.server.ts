import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { SupabaseSessionStorage } from "./lib/session-storage.server";
import { supabase } from "./supabase.server";
import { encrypt } from "./lib/crypto.server";

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
  future: {
    expiringOfflineAccessTokens: true,
  },
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
