/**
 * app/lib/sentry.server.ts
 *
 * Server-side Sentry wrapper. Initialised idempotently on first import.
 *
 * If SENTRY_DSN is not set (dev / preview without instrumentation), every call
 * is a clean no-op — the SDK is never even initialised. This keeps call sites
 * uniform across environments.
 *
 * Usage:
 *   import { sentry } from "../lib/sentry.server";
 *   sentry.addBreadcrumb({ category: "billing", message: "…", level: "info" });
 *   await sentry.captureException(err, { tags: { area: "billing.confirm" } });
 *
 * ── DELIVERY IS PART OF CAPTURE (2026-07-31) ────────────────────────────────
 *
 * `Sentry.captureException` only ENQUEUES; the SDK transport POSTs in the
 * background on a timer. On Vercel the container can freeze the instant the
 * response is returned, so a capture followed by `return new Response()` never
 * left the box. The evidence: every event this project has ever received
 * (SHIELDKIT-1, 4 events, 2026-07-12) is `handled: no` /
 * `mechanism: auto.ai.anthropic` — auto-instrumentation on an error that
 * unwound through the framework, which flushes on the way out. NOT ONE event
 * from an explicit sentry.* call had ever been delivered.
 *
 * PR #19 fixed that by adding `await sentry.flush()` after the captures it
 * touched. That left 40 other capture sites unflushed and made correct
 * behaviour a thing each caller had to remember — the same "multi-step cleanup
 * spread across call sites" shape that had already been got wrong twice in this
 * codebase (the AI credit, the scan-quota refund). So the flush moved INTO
 * capture: the wrapper enqueues and drains in one call, and a caller cannot
 * forget the second half because there is no second half.
 *
 * The captures are therefore ASYNC and return the Sentry event id. `await` them
 * where you are about to return a Response. Not awaiting is still far better
 * than the old behaviour — the HTTP POST is already in flight when the handler
 * returns, instead of sitting in a queue waiting for a timer that never fires —
 * but only `await` actually guarantees delivery.
 *
 * Bounded (2s) and always resolving, so a degraded Sentry can never hold a
 * merchant request, a webhook ACK, or a GDPR handler.
 */

import * as Sentry from "@sentry/node";
import { withTimeout } from "./with-timeout";

// Hard ceiling for a flush attempt. Mirrors analytics.server.ts: telemetry is
// best-effort, and a degraded Sentry ingest must never block a response.
const FLUSH_TIMEOUT_MS = 2000;

let initialized = false;

function initSentry(): void {
  if (initialized) return;

  const dsn = process.env.SENTRY_DSN;
  // No DSN → skip Sentry.init() entirely. Calling init even with an undefined
  // DSN still builds a client and registers global error/unhandledRejection
  // handlers — pure wasted CPU on every serverless cold start when we have
  // nowhere to send events. The wrappers below no-op while uninitialized, so
  // call sites stay identical across environments.
  if (!dsn) return;

  initialized = true;
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    // Keep traces off by default — breadcrumb + capture is what we need.
    tracesSampleRate: 0,
    // Strip Authorization headers and cookies from breadcrumbs by default.
    sendDefaultPii: false,
  });
}

initSentry();

/**
 * Drain the transport, bounded. Sentry.flush(ms) is a TIMEOUT, not a duration:
 * with nothing queued it resolves on the spot, so a capture-free request pays
 * nothing. Only a request that actually captured something waits, and only for
 * as long as the POST takes.
 */
async function drain(): Promise<void> {
  await withTimeout(Sentry.flush(FLUSH_TIMEOUT_MS), FLUSH_TIMEOUT_MS);
}

export const sentry = {
  /**
   * Breadcrumbs are NOT events — they attach to a subsequent capture in the
   * same scope. Nothing to flush, so this stays synchronous and free.
   */
  addBreadcrumb: (breadcrumb: Sentry.Breadcrumb) => {
    if (!initialized) return;
    Sentry.addBreadcrumb(breadcrumb);
  },

  /**
   * Capture an exception AND deliver it. Returns the Sentry event id, or
   * undefined when Sentry is not configured.
   */
  captureException: async (
    err: unknown,
    context?: { tags?: Record<string, string>; extra?: Record<string, unknown> },
  ): Promise<string | undefined> => {
    if (!initialized) return undefined; // no DSN → cheap no-op, no timers, no await cost
    const eventId = Sentry.captureException(err, {
      tags: context?.tags,
      extra: context?.extra,
    });
    await drain();
    return eventId;
  },

  /**
   * Capture a message AND deliver it. Returns the Sentry event id, or
   * undefined when Sentry is not configured.
   */
  captureMessage: async (
    message: string,
    level: Sentry.SeverityLevel = "info",
    context?: { tags?: Record<string, string>; extra?: Record<string, unknown> },
  ): Promise<string | undefined> => {
    if (!initialized) return undefined; // no DSN → cheap no-op
    const eventId = Sentry.captureMessage(message, {
      level,
      tags: context?.tags,
      extra: context?.extra,
    });
    await drain();
    return eventId;
  },

  /**
   * Standalone drain. Production code should NOT need this — captureException
   * and captureMessage already flush. Retained for the alerting health check
   * and for tests. If you find yourself reaching for it after a capture, the
   * capture already did it.
   */
  flush: async (): Promise<void> => {
    if (!initialized) return;
    await drain();
  },
};
