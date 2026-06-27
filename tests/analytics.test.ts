/**
 * tests/analytics.test.ts
 *
 * Coverage for the server-side PostHog wrapper (app/lib/analytics.server.ts).
 *
 * The hard contract for this module: analytics must NEVER break a request.
 * captureEvent must
 *   - be a clean no-op when POSTHOG_API_KEY is unset (no client constructed),
 *   - capture with distinct_id = shop domain and await a flush when configured,
 *   - swallow any error from capture() or flush() and never reject.
 *
 * Mirrors the mock style in tests/shop-redact.test.ts: a hand-rolled posthog-node
 * stub whose calls are recorded in module-scoped arrays, reset per test, plus a
 * file-shape pass that locks in the serverless flush config.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ─── Mutable harness state (read inside the hoisted vi.mock factory) ──────────
let ctorArgs: Array<{ key: string; opts: Record<string, unknown> }> = [];
let captureCalls: Array<{ distinctId: string; event: string; properties?: Record<string, unknown> }> = [];
let flushCalls = 0;
let throwOnCapture = false;
let rejectOnFlush = false;
let hangOnFlush = false; // simulate a reachable-but-degraded PostHog (slow-loris)

vi.mock("posthog-node", () => ({
  PostHog: class {
    constructor(key: string, opts: Record<string, unknown>) {
      ctorArgs.push({ key, opts });
    }
    capture(payload: { distinctId: string; event: string; properties?: Record<string, unknown> }) {
      if (throwOnCapture) throw new Error("capture boom");
      captureCalls.push(payload);
    }
    flush() {
      flushCalls++;
      if (hangOnFlush) return new Promise<void>(() => {}); // never settles
      if (rejectOnFlush) return Promise.reject(new Error("flush boom"));
      return Promise.resolve();
    }
  },
}));

// Fresh module per test so the lazy module-cached client / triedInit flag is
// re-evaluated against the current stubbed env.
async function loadModule() {
  vi.resetModules();
  return import("../app/lib/analytics.server");
}

describe("captureEvent — runtime behavior", () => {
  beforeEach(() => {
    ctorArgs = [];
    captureCalls = [];
    flushCalls = 0;
    throwOnCapture = false;
    rejectOnFlush = false;
    hangOnFlush = false;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("is a clean no-op when POSTHOG_API_KEY is unset (no client constructed)", async () => {
    vi.stubEnv("POSTHOG_API_KEY", "");
    const { captureEvent } = await loadModule();

    await expect(
      captureEvent("store.myshopify.com", "scan_run", { critical_count: 3 }),
    ).resolves.toBeUndefined();

    expect(ctorArgs).toHaveLength(0);
    expect(captureCalls).toHaveLength(0);
    expect(flushCalls).toBe(0);
  });

  it("captures with distinct_id = shop domain and awaits a flush when configured", async () => {
    vi.stubEnv("POSTHOG_API_KEY", "phc_test");
    vi.stubEnv("POSTHOG_HOST", "https://eu.i.posthog.com");
    const { captureEvent } = await loadModule();

    await captureEvent("store.myshopify.com", "scan_run", { critical_count: 3, tier: "free" });

    expect(captureCalls).toHaveLength(1);
    expect(captureCalls[0].distinctId).toBe("store.myshopify.com");
    expect(captureCalls[0].event).toBe("scan_run");
    expect(captureCalls[0].properties).toEqual({ critical_count: 3, tier: "free" });
    expect(flushCalls).toBe(1);
    // Serverless flush config + the bounded-flush guard are wired through to
    // the client constructor (single short attempt, no retries).
    expect(ctorArgs[0].opts).toMatchObject({
      flushAt: 1,
      flushInterval: 0,
      fetchRetryCount: 0,
    });
    expect(ctorArgs[0].opts.requestTimeout).toBeTypeOf("number");
    expect(ctorArgs[0].opts.host).toBe("https://eu.i.posthog.com");
  });

  it("never blocks the request when flush() hangs (degraded PostHog)", async () => {
    vi.stubEnv("POSTHOG_API_KEY", "phc_test");
    hangOnFlush = true;
    const { captureEvent } = await loadModule();

    vi.useFakeTimers();
    let settled = false;
    const p = captureEvent("store.myshopify.com", "install").then(() => {
      settled = true;
    });

    // Still waiting partway through the bound — proves we actually attempted
    // delivery rather than skipping the flush.
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toBe(false);

    // Past the bound → resolves cleanly despite flush() never settling.
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    expect(settled).toBe(true);
  });

  it("reuses one module-cached client across captures", async () => {
    vi.stubEnv("POSTHOG_API_KEY", "phc_test");
    const { captureEvent } = await loadModule();

    await captureEvent("a.myshopify.com", "install");
    await captureEvent("b.myshopify.com", "purchase", { tier: "monitoring" });

    expect(ctorArgs).toHaveLength(1); // constructed once, not per-capture
    expect(captureCalls).toHaveLength(2);
    expect(flushCalls).toBe(2);
  });

  it("swallows a capture() throw and never rejects", async () => {
    vi.stubEnv("POSTHOG_API_KEY", "phc_test");
    throwOnCapture = true;
    const { captureEvent } = await loadModule();

    await expect(
      captureEvent("store.myshopify.com", "install"),
    ).resolves.toBeUndefined();
  });

  it("swallows a flush() rejection and never rejects", async () => {
    vi.stubEnv("POSTHOG_API_KEY", "phc_test");
    rejectOnFlush = true;
    const { captureEvent } = await loadModule();

    await expect(
      captureEvent("store.myshopify.com", "purchase", { tier: "monitoring" }),
    ).resolves.toBeUndefined();
  });
});

describe("analytics.server — file shape", () => {
  const src = readFileSync(
    join(__dirname, "..", "app", "lib", "analytics.server.ts"),
    "utf8",
  );

  it("configures the serverless flush (flushAt:1, flushInterval:0)", () => {
    expect(src).toMatch(/flushAt:\s*1/);
    expect(src).toMatch(/flushInterval:\s*0/);
  });

  it("awaits a flush after every capture (the serverless drop gotcha)", () => {
    expect(src).toMatch(/\w+\.flush\(\)/);
  });

  it("bounds the flush so a degraded PostHog can never block the request", () => {
    // Single short attempt (no 10s × 4 + backoff ≈ 49s default) …
    expect(src).toMatch(/requestTimeout:/);
    expect(src).toMatch(/fetchRetryCount:\s*0/);
    // … and a hard timeout wrapper around the awaited flush.
    expect(src).toMatch(/withTimeout\(\s*\w+\.flush\(\)/);
  });

  it("wraps captures in try/catch and warns rather than throwing", () => {
    expect(src).toContain("try {");
    expect(src).toContain("catch");
    expect(src).toContain("console.warn");
  });

  it("no-ops on a missing POSTHOG_API_KEY", () => {
    expect(src).toContain("POSTHOG_API_KEY");
    expect(src).toMatch(/if\s*\(!apiKey\)/);
  });

  it("keys events on the shop domain as distinct_id", () => {
    expect(src).toMatch(/distinctId:\s*shopDomain/);
  });
});
