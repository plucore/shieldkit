/**
 * app/lib/analytics.client.ts
 *
 * Browser-side PostHog wrapper for the two true-UI funnel signals the server
 * can't see: scan_result_viewed and upgrade_cta_clicked. These are SECONDARY
 * to the server-side events (app/lib/analytics.server.ts) — embedded-iframe
 * client capture is flaky, so the server events are the source of truth.
 *
 * Design rules (same spirit as analytics.server.ts):
 *   - No-op cleanly when the PostHog key is absent (guarded everywhere).
 *   - Never throw: every call is wrapped in try/catch + console.warn.
 *   - distinct_id = shop domain (via identify) so client + server events tie
 *     together for the same merchant.
 *
 * posthog-js is loaded with a dynamic import() so it is never evaluated during
 * SSR and never weighs down the server bundle. The resolved singleton is kept
 * in module scope so captureClient() can fire synchronously (important for
 * upgrade_cta_clicked, which fires immediately before a top-frame navigation).
 *
 * This is the `.client.ts` half of the pair — React Router strips it from the
 * server build, so these helpers only ever run in the browser.
 */

// posthog-js' default export is a singleton; we hold the resolved instance so
// captureClient() doesn't have to await the dynamic import on the hot path.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let posthog: any = null;
let initialized = false;

interface InitOptions {
  apiKey: string | null;
  host: string | null;
  shopDomain?: string | null;
}

/**
 * Initialise posthog-js once (idempotent) and identify the merchant by shop
 * domain. Safe to call from multiple mount points (root + dashboard) — the
 * `initialized` guard means the real init only happens once. Resolves cleanly
 * (no throw) when the key is unset or anything goes wrong.
 */
export async function initAnalytics(opts: InitOptions): Promise<void> {
  try {
    if (typeof window === "undefined") return;
    if (!opts.apiKey) return; // no-op when POSTHOG_API_KEY unset

    if (!posthog) {
      posthog = (await import("posthog-js")).default;
    }

    if (!initialized) {
      posthog.init(opts.apiKey, {
        api_host: opts.host || "https://us.i.posthog.com",
        // Only create person profiles for identified merchants — no anonymous
        // profiles from the public marketing site or pre-identify renders.
        person_profiles: "identified_only",
        // Measurement only: we capture explicit funnel events, not autocaptured
        // clicks/inputs or pageviews. Avoids ingesting incidental Shopify-admin
        // interactions from inside the embedded iframe.
        autocapture: false,
        capture_pageview: false,
      });
      initialized = true;
    }

    if (opts.shopDomain) {
      posthog.identify(opts.shopDomain);
    }
  } catch (err) {
    console.warn("[analytics.client] init failed:", err);
  }
}

/**
 * Capture a client-side funnel event. No-ops until initAnalytics() has run.
 * Synchronous so it fires before any navigation that follows it.
 */
export function captureClient(
  event: string,
  properties?: Record<string, unknown>,
): void {
  try {
    if (typeof window === "undefined") return;
    if (!posthog || !initialized) return; // not configured → no-op
    posthog.capture(event, properties);
  } catch (err) {
    console.warn(`[analytics.client] capture failed for "${event}":`, err);
  }
}
