/**
 * tests/sentry-flush.test.ts
 *
 * Sentry delivery in a serverless runtime (app/lib/sentry.server.ts).
 *
 * WHY THIS EXISTS. capture* only ENQUEUES; the SDK transport POSTs in the
 * background. On Vercel the function can freeze the instant the response is
 * returned, so a capture followed by `return new Response()` never leaves the
 * box. Evidence from production on 2026-07-30: every event this project has
 * ever received (SHIELDKIT-1, 4 events) is `handled: no` /
 * `mechanism: auto.ai.anthropic` — auto-instrumentation on an error that
 * unwound through the framework. NOT ONE event from an explicit sentry.* call
 * has ever been delivered, including the `Entitlement REVOKED` captureMessage
 * that provably ran for 7wf1na-x2 at 09:12:08.
 *
 * The contract these tests lock in:
 *   1. sentry.flush() exists, is bounded, and ALWAYS resolves — a degraded
 *      Sentry must never hold a webhook ACK or a merchant request.
 *   2. It is a clean no-op when SENTRY_DSN is unset.
 *   3. The entitlement-revoked alarm actually awaits it before the ACK.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");

// ─── Hoisted @sentry/node stub ───────────────────────────────────────────────
let flushCalls: number[] = [];
let hangOnFlush = false;
let rejectOnFlush = false;

vi.mock("@sentry/node", () => ({
  init: () => {},
  addBreadcrumb: () => {},
  captureException: () => {},
  captureMessage: () => {},
  flush: (ms?: number) => {
    flushCalls.push(ms ?? -1);
    if (hangOnFlush) return new Promise<boolean>(() => {}); // never settles
    if (rejectOnFlush) return Promise.reject(new Error("flush boom"));
    return Promise.resolve(true);
  },
}));

async function loadModule(dsn?: string) {
  vi.resetModules();
  if (dsn) process.env.SENTRY_DSN = dsn;
  else delete process.env.SENTRY_DSN;
  return await import("../app/lib/sentry.server");
}

beforeEach(() => {
  flushCalls = [];
  hangOnFlush = false;
  rejectOnFlush = false;
});

describe("sentry.flush() — serverless delivery", () => {
  it("is a clean no-op when SENTRY_DSN is unset (never touches the SDK)", async () => {
    const { sentry } = await loadModule(undefined);
    await expect(sentry.flush()).resolves.toBeUndefined();
    expect(flushCalls).toHaveLength(0);
  });

  it("flushes the SDK when a DSN is configured", async () => {
    const { sentry } = await loadModule("https://abc@o1.ingest.sentry.io/1");
    await sentry.flush();
    expect(flushCalls).toHaveLength(1);
  });

  it("RESOLVES even when the flush hangs — a degraded Sentry cannot block a request", async () => {
    vi.useFakeTimers();
    try {
      const { sentry } = await loadModule("https://abc@o1.ingest.sentry.io/1");
      hangOnFlush = true;

      let settled = false;
      const p = sentry.flush(2000).then(() => {
        settled = true;
      });

      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2100);
      await p;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves (never rejects) when the flush rejects", async () => {
    const { sentry } = await loadModule("https://abc@o1.ingest.sentry.io/1");
    rejectOnFlush = true;
    await expect(sentry.flush()).resolves.toBeUndefined();
  });
});

describe("flush is wired where captures precede an immediate return", () => {
  it("sentry.server.ts bounds the flush via the shared withTimeout helper", () => {
    const src = readFileSync(join(ROOT, "app/lib/sentry.server.ts"), "utf-8");
    expect(src).toContain('import { withTimeout } from "./with-timeout"');
    expect(src).toMatch(/withTimeout\(\s*Sentry\.flush\(/);
    // Bounded, not unbounded — an unbounded flush reintroduces the hazard the
    // PostHog wrapper documents at length.
    expect(src).toMatch(/FLUSH_TIMEOUT_MS\s*=\s*\d+/);
  });

  it("withTimeout lives in ONE place, imported by both telemetry sinks", () => {
    const shared = readFileSync(join(ROOT, "app/lib/with-timeout.ts"), "utf-8");
    expect(shared).toContain("export function withTimeout");

    const analytics = readFileSync(join(ROOT, "app/lib/analytics.server.ts"), "utf-8");
    expect(analytics).toContain('import { withTimeout } from "./with-timeout"');
    // The private copy must be gone, not shadowing the shared one.
    expect(analytics).not.toMatch(/function withTimeout\(/);
  });

  it("the entitlement-revoked alarm awaits the flush BEFORE the webhook ACK", () => {
    const src = readFileSync(
      join(ROOT, "app/routes/webhooks.app_subscriptions.update.tsx"),
      "utf-8",
    );
    const captureIdx = src.indexOf("Entitlement REVOKED");
    const flushIdx = src.indexOf("await sentry.flush()");
    expect(captureIdx).toBeGreaterThan(0);
    expect(flushIdx).toBeGreaterThan(captureIdx);
  });
});
