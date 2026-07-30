/**
 * app/lib/scan-failure.server.ts
 *
 * One place that records a failed compliance scan.
 *
 * WHY THIS EXISTS. Until 2026-07-30 a failed scan produced NOTHING: no PostHog
 * event (scan_run fires only on success), no Sentry capture (both catch blocks
 * called console.error only), and no counter. The failure rate was therefore
 * unmeasurable from any source — which is why the quota over-refund, whose
 * trigger is precisely a failed scan, ran undetected. `webhook_failures` was no
 * help either: it records Supabase write errors, not scan outcomes.
 *
 * It is a single function rather than "emit an event and also capture and also
 * flush" at each call site, because the codebase has now twice demonstrated
 * that a multi-step cleanup spread across call sites gets half-done (the AI
 * credit refund was missed at five sites; the scan quota refund was wrong at
 * two). Two call sites, one function, all three steps or none.
 *
 * Never throws. Instrumentation must not convert a handled scan failure into an
 * unhandled one.
 */

import { captureEvent } from "./analytics.server";
import { sentry } from "./sentry.server";

/** Which surface the merchant used. Lets us segment failures by entry point. */
export type ScanFailureEntryPoint = "dashboard" | "api";

/**
 * Bucket an error into a low-cardinality class suitable for grouping.
 *
 * Raw messages carry shop domains and Shopify request ids, so they explode
 * cardinality and leak identifiers into analytics. The classes below are the
 * failure modes the scan actually has — see graphql-client.server.ts (which
 * throws on any non-2xx from the Admin API) and checks/index.server.ts.
 */
export function classifyScanError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";

  // Ordered most-specific first; several of these co-occur in one message.
  if (message.includes("No access token")) return "token_missing";
  if (message.includes("Failed to insert scan record")) return "scan_insert_failed";
  if (name === "AbortError" || /timeout|timed out/i.test(message)) return "timeout";
  if (/THROTTLED/i.test(message)) return "throttled";

  const http = message.match(/HTTP (\d{3})/);
  if (http) {
    const code = Number(http[1]);
    if (code === 401) return "admin_api_401";
    if (code === 403) return "admin_api_403";
    if (code === 429) return "throttled";
    if (code >= 500) return "admin_api_5xx";
    return `admin_api_${code}`;
  }

  if (/decrypt/i.test(message)) return "token_decrypt_failed";
  return name || "unknown";
}

/**
 * Record a scan failure to PostHog AND Sentry, then flush both.
 *
 * The flush is the whole point of routing Sentry through here: capture only
 * enqueues, and both callers return a Response immediately afterwards, so
 * without it the event dies with the container (see sentry.server.ts).
 */
export async function recordScanFailure(args: {
  shopDomain: string;
  entryPoint: ScanFailureEntryPoint;
  err: unknown;
  tier?: string | null;
  /** Whether the compensating quota refund ran (false for unlimited/paid). */
  quotaRefunded: boolean;
}): Promise<void> {
  const errorClass = classifyScanError(args.err);

  try {
    await captureEvent(args.shopDomain, "scan_failed", {
      entry_point: args.entryPoint,
      error_class: errorClass,
      tier: args.tier ?? null,
      quota_refunded: args.quotaRefunded,
    });
  } catch (e) {
    console.warn("[scan-failure] analytics capture failed:", e);
  }

  try {
    sentry.captureException(args.err, {
      tags: {
        area: "compliance-scan",
        entry_point: args.entryPoint,
        error_class: errorClass,
      },
      extra: { shop: args.shopDomain, quota_refunded: args.quotaRefunded },
    });
    await sentry.flush();
  } catch (e) {
    console.warn("[scan-failure] sentry capture failed:", e);
  }
}
