/**
 * app/lib/sentry.server.ts
 *
 * Server-side Sentry wrapper. Initialised idempotently on first import.
 *
 * If SENTRY_DSN is not set (dev / preview without instrumentation), all calls
 * are no-ops — the @sentry/node SDK is still initialised but with no DSN, so
 * `addBreadcrumb` / `captureException` silently discard. This keeps call sites
 * uniform across environments.
 *
 * Usage:
 *   import { sentry } from "../lib/sentry.server";
 *   sentry.addBreadcrumb({
 *     category: "billing",
 *     message: "partner_api_status=active",
 *     level: "info",
 *     data: { shop: session.shop, tier: sub.tier },
 *   });
 *   sentry.captureException(err, { tags: { area: "billing.confirm" } });
 *   await sentry.flush();   // REQUIRED before returning from a serverless handler
 *
 * ── Serverless flush gotcha (2026-07-30) ──────────────────────────────────────
 * capture* only ENQUEUES an event; the SDK's transport POSTs it in the
 * background. On Vercel the function can freeze the instant the response is
 * returned, so a capture immediately followed by `return new Response()` never
 * leaves the box. This is the same hazard analytics.server.ts documents for
 * PostHog — and until now Sentry had no equivalent guard.
 *
 * The evidence: every event this project has ever received (SHIELDKIT-1, 4
 * events on 2026-07-12) is `handled: no` / `mechanism: auto.ai.anthropic` —
 * auto-instrumentation on an error that unwound through the framework, which
 * flushes on the way out. NOT ONE event from an explicit sentry.* call in this
 * codebase has ever been delivered, including the `Entitlement REVOKED`
 * captureMessage that provably ran for 7wf1na-x2 on 2026-07-30 09:12:08.
 *
 * So: after any capture on a path that returns promptly, `await sentry.flush()`.
 * It is bounded and always resolves, so it can never hold a merchant's request.
 */

import * as Sentry from "@sentry/node";
import { withTimeout } from "./with-timeout";

// Hard ceiling for a flush attempt. Mirrors analytics.server.ts: telemetry is
// best-effort, and a degraded Sentry ingest must never block a webhook ACK, a
// cron, or a merchant-facing response.
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

export const sentry = {
  addBreadcrumb: (breadcrumb: Sentry.Breadcrumb) => {
    if (!initialized) return;
    Sentry.addBreadcrumb(breadcrumb);
  },
  captureException: (
    err: unknown,
    context?: { tags?: Record<string, string>; extra?: Record<string, unknown> },
  ) => {
    if (!initialized) return;
    Sentry.captureException(err, {
      tags: context?.tags,
      extra: context?.extra,
    });
  },
  captureMessage: (
    message: string,
    level: Sentry.SeverityLevel = "info",
    context?: { tags?: Record<string, string>; extra?: Record<string, unknown> },
  ) => {
    if (!initialized) return;
    Sentry.captureMessage(message, {
      level,
      tags: context?.tags,
      extra: context?.extra,
    });
  },
  /**
   * Deliver everything queued so far, bounded by FLUSH_TIMEOUT_MS.
   *
   * Always resolves — never rejects, never waits longer than the bound — so it
   * is safe to await on any path, including webhook ACKs and GDPR handlers.
   * A no-op when Sentry is uninitialised (no DSN), exactly like the captures.
   */
  flush: async (ms: number = FLUSH_TIMEOUT_MS): Promise<void> => {
    if (!initialized) return;
    await withTimeout(Sentry.flush(ms), ms);
  },
};
