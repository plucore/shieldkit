import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { SupabaseSessionStorage } from "./lib/session-storage.server";
import { supabase } from "./supabase.server";
import { encrypt } from "./lib/crypto.server";
import { SHOPIFY_BILLING_CONFIG } from "./lib/billing/plans";

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
  // ─── Shopify billing plans (v2 — recurring) ──────────────────────────────
  // Plan definitions live in app/lib/billing/plans.ts as SHOPIFY_BILLING_CONFIG.
  // Plan names ("Shield", "Shield Annual", "Shield Pro", "Shield Pro Annual")
  // are the strings billing.request({ plan }) accepts and that come back in
  // APP_SUBSCRIPTIONS_UPDATE webhook payloads. Re-run `npm run deploy` after
  // changing plan names so Shopify re-registers them.
  billing: SHOPIFY_BILLING_CONFIG,
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
  hooks: {
    afterAuth: async ({ session }) => {
      // afterAuth fires after every successful OAuth completion (install + re-auth).
      // Only process offline sessions — these are the persistent merchant sessions.
      // Online sessions (short-lived user sessions) do not represent an install.
      if (session.isOnline) return;

      // Upsert merchant record. On first install: INSERT with defaults.
      // On reinstall after uninstall: UPDATE clears uninstalled_at and refreshes token.
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
