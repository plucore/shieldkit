/**
 * tests/sentry-flush.test.ts
 *
 * Delivery is part of capture (2026-07-31).
 *
 * BACKGROUND. `Sentry.captureException` only ENQUEUES; the transport POSTs on a
 * background timer. On Vercel the container can freeze the instant the response
 * is returned, so a capture followed by `return new Response()` never left the
 * box. Every event this project has ever received is `handled: no` /
 * `mechanism: auto.ai.anthropic` — auto-instrumentation on an error that unwound
 * through the framework. Not one explicit sentry.* call had ever been delivered.
 *
 * PR #19 added `await sentry.flush()` after the captures it touched, leaving 40
 * other sites unflushed and making correctness something each caller had to
 * remember — the same "multi-step cleanup spread across call sites" shape this
 * codebase had already got wrong twice. So the flush moved INTO capture.
 *
 * The contract these tests pin:
 *   1. capture* flush internally and return the Sentry event id.
 *   2. No DSN → cheap no-op: the SDK is never touched at all.
 *   3. A degraded/hanging Sentry can never hold a request (bounded, always
 *      resolves).
 *   4. An empty queue costs nothing — flush is a TIMEOUT, not a duration. This
 *      is what keeps the scan path free when no capture happened.
 *   5. Production code calls sentry.flush() NOWHERE — exactly one way to do it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");

// ─── Hoisted @sentry/node stub ───────────────────────────────────────────────
let initCalls = 0;
let captureExceptionCalls = 0;
let captureMessageCalls = 0;
let flushCalls: number[] = [];
let hangOnFlush = false;
let rejectOnFlush = false;

vi.mock("@sentry/node", () => ({
  init: () => {
    initCalls += 1;
  },
  addBreadcrumb: () => {},
  captureException: () => {
    captureExceptionCalls += 1;
    return "evt-exception-id";
  },
  captureMessage: () => {
    captureMessageCalls += 1;
    return "evt-message-id";
  },
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

const DSN = "https://abc@o1.ingest.sentry.io/1";

beforeEach(() => {
  initCalls = 0;
  captureExceptionCalls = 0;
  captureMessageCalls = 0;
  flushCalls = [];
  hangOnFlush = false;
  rejectOnFlush = false;
});

describe("capture delivers — the caller cannot forget the second half", () => {
  it("captureException flushes and returns the event id", async () => {
    const { sentry } = await loadModule(DSN);
    const id = await sentry.captureException(new Error("boom"));
    expect(captureExceptionCalls).toBe(1);
    expect(flushCalls).toHaveLength(1);
    expect(id).toBe("evt-exception-id");
  });

  it("captureMessage flushes and returns the event id", async () => {
    const { sentry } = await loadModule(DSN);
    const id = await sentry.captureMessage("hello", "warning");
    expect(captureMessageCalls).toBe(1);
    expect(flushCalls).toHaveLength(1);
    expect(id).toBe("evt-message-id");
  });

  it("addBreadcrumb does NOT flush — breadcrumbs are not events", async () => {
    // They attach to a subsequent capture. Flushing here would be pure latency
    // for nothing, and reconcile-installs emits one per merchant (38 on
    // 2026-07-31) — that would have been 38 pointless round trips.
    const { sentry } = await loadModule(DSN);
    sentry.addBreadcrumb({ category: "x", message: "y", level: "info" });
    expect(flushCalls).toHaveLength(0);
  });
});

describe("no DSN is a cheap no-op", () => {
  it("never initialises the SDK, never captures, never flushes", async () => {
    const { sentry } = await loadModule(undefined);

    await expect(sentry.captureException(new Error("x"))).resolves.toBeUndefined();
    await expect(sentry.captureMessage("x")).resolves.toBeUndefined();
    await expect(sentry.flush()).resolves.toBeUndefined();
    sentry.addBreadcrumb({ message: "x" });

    // The whole point: dev and preview pay literally nothing — no client, no
    // global handlers, no timers, no awaited round trip.
    expect(initCalls).toBe(0);
    expect(captureExceptionCalls).toBe(0);
    expect(captureMessageCalls).toBe(0);
    expect(flushCalls).toHaveLength(0);
  });

  it("resolves immediately, so an unconfigured env adds no latency", async () => {
    const { sentry } = await loadModule(undefined);
    const started = Date.now();
    for (let i = 0; i < 100; i++) await sentry.captureException(new Error("x"));
    // 100 captures in well under a frame — no I/O on this path at all.
    expect(Date.now() - started).toBeLessThan(50);
  });
});

describe("a degraded Sentry can never hold a request", () => {
  it("RESOLVES even when the flush hangs", async () => {
    vi.useFakeTimers();
    try {
      const { sentry } = await loadModule(DSN);
      hangOnFlush = true;

      let settled = false;
      const p = sentry.captureException(new Error("boom")).then(() => {
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
    const { sentry } = await loadModule(DSN);
    rejectOnFlush = true;
    await expect(sentry.captureException(new Error("x"))).resolves.toBe(
      "evt-exception-id",
    );
  });

  it("passes a bounded timeout to the SDK, not an unbounded drain", async () => {
    const { sentry } = await loadModule(DSN);
    await sentry.captureMessage("x");
    expect(flushCalls[0]).toBeGreaterThan(0);
    expect(flushCalls[0]).toBeLessThanOrEqual(2000);
  });
});

describe("there is exactly ONE way this works", () => {
  it("no production code calls sentry.flush()", () => {
    // capture* already flush. A stray flush after a capture would be a caller
    // re-learning the old two-step contract that this design removed.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSyncSafe(dir)) {
        const full = join(dir, entry);
        if (isDir(full)) walk(full);
        else if (/\.(ts|tsx)$/.test(entry)) {
          const src = readFileSync(full, "utf-8");
          if (full.endsWith("sentry.server.ts")) continue;
          if (src.includes("sentry.flush(")) offenders.push(full);
        }
      }
    };
    walk(join(ROOT, "app"));
    expect(offenders).toEqual([]);
  });

  it("the entitlement-revoked alarm AWAITS its capture before the ACK", () => {
    const src = readFileSync(
      join(ROOT, "app/routes/webhooks.app_subscriptions.update.tsx"),
      "utf-8",
    );
    // Awaiting is what guarantees delivery; the capture flushes internally but
    // an un-awaited one can still lose the race with the container freezing.
    expect(src).toMatch(/await sentry\.captureMessage\(\s*\n?\s*`Entitlement REVOKED/);
  });

  it("the AI generators await their capture before re-throwing", () => {
    for (const rel of [
      "app/lib/policy-generator.server.ts",
      "app/lib/llm/appeal-letter.server.ts",
    ]) {
      const src = readFileSync(join(ROOT, rel), "utf-8");
      expect(src).toMatch(/await sentry\.captureException\(/);
      // The .catch must be async or the await is a syntax error.
      expect(src).toMatch(/\.catch\(async \(err: unknown\) =>/);
    }
  });
});

// ─── tiny fs helpers (avoid pulling in a glob dep) ───────────────────────────
import { readdirSync, statSync } from "node:fs";
function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
