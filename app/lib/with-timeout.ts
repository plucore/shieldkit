/**
 * app/lib/with-timeout.ts
 *
 * Bound a best-effort background delivery so it can never hold a request.
 *
 * Extracted from analytics.server.ts (2026-07-30) because Sentry needs the
 * identical guarantee and the alternative was a second copy of the same twelve
 * lines. Both telemetry sinks — PostHog and Sentry — are fire-and-forget from
 * the caller's point of view but must be *flushed* before a serverless function
 * freezes, and neither may block the merchant if the sink is degraded.
 */

/**
 * Await a promise but never longer than `ms`. Always resolves (never rejects);
 * a settled-or-timed-out flush is best-effort either way. The timer is unref'd
 * so a pending bound never keeps the serverless function alive on its own, and
 * cleared the moment the work settles so the fast path returns immediately.
 */
export function withTimeout(p: Promise<unknown>, ms: number): Promise<void> {
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
