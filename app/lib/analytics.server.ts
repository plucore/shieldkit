/**
 * app/lib/analytics.server.ts
 *
 * Server-side PostHog wrapper for the activation→conversion funnel
 * (install → scan_run → paywall_viewed → purchase). These server events are
 * the reliable backbone — embedded-iframe client analytics is flaky, so the
 * funnel leans on these.
 *
 * Mirrors the Sentry-when-unset pattern (see app/lib/sentry.server.ts): if
 * POSTHOG_API_KEY is not set, every call is a clean no-op. Analytics must
 * NEVER break a request — every capture is wrapped in try/catch and swallows
 * errors with console.warn. Billing and scan paths behave identically whether
 * PostHog is configured, down, or absent.
 *
 * distinct_id is ALWAYS the shop domain so a merchant's server-side and
 * client-side events tie together.
 *
 * ── Serverless flush gotcha (the #1 reason events silently drop) ──
 * posthog-node batches events and flushes them on a timer. On Vercel the
 * function can freeze the moment the response is sent — before that timer
 * fires — so a fire-and-forget capture never leaves the box. We construct the
 * client with { flushAt: 1, flushInterval: 0 } and `await posthog.flush()`
 * after every capture so the event is delivered before the function freezes.
 *
 * ── …without ever BLOCKING the request ──
 * Awaiting flush() introduces the opposite risk: a reachable-but-degraded
 * PostHog ingest endpoint. posthog-node's defaults (requestTimeout 10s ×
 * 1+fetchRetryCount=4 attempts + 3×3s backoff ≈ 49s) would let a slow-loris
 * endpoint hold the awaited flush for ~49s — and a try/catch only catches a
 * throw/reject, not a slow resolve. On the install (OAuth) and purchase
 * (post-payment redirect) paths that would break the "never block a request /
 * behave identically if PostHog is down" guardrail and risk Vercel's 60s
 * function ceiling. So we (a) bound the client to a single 2s attempt
 * (requestTimeout + fetchRetryCount:0) and (b) race flush() against a hard
 * timeout that always RESOLVES — best-effort delivery, never a held request.
 *
 * Env:
 *   POSTHOG_API_KEY   phc_… project key (publishable; also used by posthog-js)
 *   POSTHOG_HOST      region ingestion host, e.g. https://us.i.posthog.com
 *                     (EU projects: https://eu.i.posthog.com)
 *
 * This SDK path is independent of any PostHog MCP connector.
 */

import { PostHog } from "posthog-node";

// Hard ceiling for a single flush attempt AND the overall await. Keeps a
// degraded PostHog from holding install/purchase/scan requests. Analytics is
// best-effort: if delivery doesn't complete inside this window we drop it
// rather than block the merchant.
const FLUSH_TIMEOUT_MS = 2000;

// Module-cached client. `triedInit` makes the lazy init idempotent: we resolve
// the key/host exactly once per process (env is fixed for a serverless
// instance's lifetime). When the key is absent, `client` stays null and every
// capture short-circuits to a no-op.
let client: PostHog | null = null;
let triedInit = false;

function getClient(): PostHog | null {
  if (triedInit) return client;
  triedInit = true;

  const apiKey = process.env.POSTHOG_API_KEY;
  if (!apiKey) {
    // No-op mode — mirrors sentry-when-unset. Call sites stay uniform.
    client = null;
    return null;
  }

  try {
    client = new PostHog(apiKey, {
      host: process.env.POSTHOG_HOST || "https://us.i.posthog.com",
      // Serverless config: flush on the first queued event, no background
      // timer. We await flush() explicitly after each capture below.
      flushAt: 1,
      flushInterval: 0,
      // Bound a degraded-PostHog flush to a single short attempt instead of
      // the SDK default of 10s × 4 attempts + backoff (~49s). See the header
      // comment — this is what keeps the awaited flush from blocking install /
      // purchase / scan when the ingest endpoint is reachable but slow.
      requestTimeout: FLUSH_TIMEOUT_MS,
      fetchRetryCount: 0,
    });
  } catch (err) {
    console.warn("[analytics.server] PostHog init failed:", err);
    client = null;
  }
  return client;
}

/**
 * Await a promise but never longer than `ms`. Always resolves (never rejects);
 * a settled-or-timed-out flush is best-effort either way. The timer is
 * unref'd so a pending bound never keeps the serverless function alive on its
 * own, and cleared the moment the flush settles so the fast path returns
 * immediately.
 */
function withTimeout(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    Promise.resolve(p)
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer);
        resolve();
      });
  });
}

/**
 * Capture a server-side product event keyed to a merchant.
 *
 * @param shopDomain  used as the PostHog distinct_id (e.g. "store.myshopify.com")
 * @param event       event name (e.g. "scan_run")
 * @param properties  optional event properties
 *
 * Never throws and never rejects: a missing key, a down PostHog, or a flush
 * error all resolve cleanly so the calling request behaves identically.
 */
export async function captureEvent(
  shopDomain: string,
  event: string,
  properties?: Record<string, unknown>,
): Promise<void> {
  try {
    const ph = getClient();
    if (!ph) return; // POSTHOG_API_KEY unset → clean no-op

    ph.capture({
      distinctId: shopDomain,
      event,
      properties,
    });

    // Deliver before the serverless function freezes (without this the event
    // is queued in memory and dropped when the box is reclaimed) — but bound
    // the wait so a degraded PostHog can never block the request beyond
    // FLUSH_TIMEOUT_MS. withTimeout always resolves; delivery is best-effort.
    await withTimeout(ph.flush(), FLUSH_TIMEOUT_MS);
  } catch (err) {
    console.warn(`[analytics.server] captureEvent failed for "${event}":`, err);
  }
}
