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
 */

import * as Sentry from "@sentry/node";

let initialized = false;

function initSentry(): void {
  if (initialized) return;
  initialized = true;

  const dsn = process.env.SENTRY_DSN;
  Sentry.init({
    dsn: dsn || undefined,
    environment: process.env.NODE_ENV ?? "development",
    // Keep traces off by default — breadcrumb + capture is what we need.
    tracesSampleRate: 0,
    // Strip Authorization headers and cookies from breadcrumbs by default.
    sendDefaultPii: false,
    // Without a DSN, init still succeeds but no events are sent. That keeps
    // sentry.* call sites identical across environments.
  });
}

initSentry();

export const sentry = {
  addBreadcrumb: (breadcrumb: Sentry.Breadcrumb) => Sentry.addBreadcrumb(breadcrumb),
  captureException: (
    err: unknown,
    context?: { tags?: Record<string, string>; extra?: Record<string, unknown> },
  ) => {
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
    Sentry.captureMessage(message, {
      level,
      tags: context?.tags,
      extra: context?.extra,
    });
  },
};
