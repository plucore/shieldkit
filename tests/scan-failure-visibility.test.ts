/**
 * tests/scan-failure-visibility.test.ts
 *
 * A failed scan must leave a trace.
 *
 * Until 2026-07-30 it left none: scan_run fires only on success, both catch
 * blocks called console.error and nothing else, and no counter existed. The
 * scan failure rate was therefore unmeasurable from PostHog, Sentry,
 * webhook_failures, or the DB — which is precisely why the quota over-refund,
 * whose trigger IS a failed scan, went unnoticed until a row was spotted
 * sitting at scans_remaining = 2.
 *
 * Also covers cron_runs, which exists because reconcile-installs is
 * non-destructive and persists nothing, and Vercel Hobby drops runtime logs
 * after ~1h — so "did the job run?" had no answer at all.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");

let events: Array<{ shop: string; event: string; props?: Record<string, unknown> }> = [];
let captures: Array<{ err: unknown; ctx?: any }> = [];
let flushes = 0;

vi.mock("../app/lib/analytics.server", () => ({
  captureEvent: async (shop: string, event: string, props?: Record<string, unknown>) => {
    events.push({ shop, event, props });
  },
}));

vi.mock("../app/lib/sentry.server", () => ({
  sentry: {
    addBreadcrumb: () => {},
    captureException: (err: unknown, ctx?: any) => captures.push({ err, ctx }),
    captureMessage: () => {},
    flush: async () => {
      flushes += 1;
    },
  },
}));

beforeEach(() => {
  events = [];
  captures = [];
  flushes = 0;
});

describe("classifyScanError buckets the real failure modes", () => {
  it.each([
    ["No access token found for shop.myshopify.com", "token_missing"],
    ["[ShieldKit] Failed to insert scan record: timeout", "scan_insert_failed"],
    ["[ShopifyAPI] HTTP 401 from shop.myshopify.com: {}", "admin_api_401"],
    ["[ShopifyAPI] HTTP 403 from shop.myshopify.com: {}", "admin_api_403"],
    ["[ShopifyAPI] HTTP 429 from shop.myshopify.com: {}", "throttled"],
    ["[ShopifyAPI] HTTP 503 from shop.myshopify.com: {}", "admin_api_5xx"],
    ['{"errors":[{"extensions":{"code":"THROTTLED"}}]}', "throttled"],
    ["failed to decrypt merchant token", "token_decrypt_failed"],
  ])("%s -> %s", async (message, expected) => {
    const { classifyScanError } = await import("../app/lib/scan-failure.server");
    expect(classifyScanError(new Error(message))).toBe(expected);
  });

  it("classifies an AbortError as a timeout regardless of message", async () => {
    const { classifyScanError } = await import("../app/lib/scan-failure.server");
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    expect(classifyScanError(err)).toBe("timeout");
  });

  it("never returns a raw message (cardinality + identifier leak)", async () => {
    const { classifyScanError } = await import("../app/lib/scan-failure.server");
    const cls = classifyScanError(new Error("something odd at shop-abc.myshopify.com"));
    expect(cls).not.toContain("myshopify.com");
    expect(cls).toBe("Error");
  });
});

describe("recordScanFailure emits BOTH sinks and flushes", () => {
  it("captures a scan_failed event and a Sentry exception, then flushes", async () => {
    const { recordScanFailure } = await import("../app/lib/scan-failure.server");
    await recordScanFailure({
      shopDomain: "shop.myshopify.com",
      entryPoint: "dashboard",
      err: new Error("[ShopifyAPI] HTTP 401 from shop.myshopify.com: {}"),
      tier: "free",
      quotaRefunded: true,
    });

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("scan_failed");
    expect(events[0].shop).toBe("shop.myshopify.com");
    expect(events[0].props).toMatchObject({
      entry_point: "dashboard",
      error_class: "admin_api_401",
      tier: "free",
      quota_refunded: true,
    });

    expect(captures).toHaveLength(1);
    expect(captures[0].ctx.tags).toMatchObject({
      area: "compliance-scan",
      entry_point: "dashboard",
      error_class: "admin_api_401",
    });

    // Without the flush the capture dies with the container — the whole reason
    // no explicit sentry.* call in this codebase had ever been delivered.
    expect(flushes).toBe(1);
  });

  it("never throws, even when a sink blows up", async () => {
    const { recordScanFailure } = await import("../app/lib/scan-failure.server");
    const boom = new Error("boom");
    // Instrumentation must not convert a handled scan failure into an
    // unhandled one.
    await expect(
      recordScanFailure({
        shopDomain: "shop.myshopify.com",
        entryPoint: "api",
        err: boom,
        quotaRefunded: false,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("both scan entry points record their failures", () => {
  it.each([
    ["app/routes/app._index.tsx", "dashboard"],
    ["app/routes/api.scan.ts", "api"],
  ])("%s calls recordScanFailure with entryPoint %s", (rel, entry) => {
    const src = readFileSync(join(ROOT, rel), "utf-8");
    expect(src).toContain("recordScanFailure({");
    expect(src).toContain(`entryPoint: "${entry}"`);
    // It must sit on the failure path, after the compensating refund.
    const refundIdx = src.indexOf('rpc("refund_scan_quota"');
    const recordIdx = src.indexOf("recordScanFailure({");
    expect(refundIdx).toBeGreaterThan(0);
    expect(recordIdx).toBeGreaterThan(refundIdx);
  });
});

describe("cron_runs makes a silent cron observable", () => {
  it("reconcile-installs records every completed run, success or failure", () => {
    const src = readFileSync(
      join(ROOT, "app/routes/api.cron.reconcile-installs.ts"),
      "utf-8",
    );
    expect(src).toContain("recordCronRun({");
    expect(src).toContain('job: "reconcile-installs"');
    // ONE recording site covering both outcomes — not one per branch, which is
    // the shape that keeps getting half-done in this codebase.
    expect(src.match(/recordCronRun\(/g) ?? []).toHaveLength(1);
    // An unauthorized request is not a run and must not be logged.
    const unauthIdx = src.indexOf('"unauthorized"');
    const recordIdx = src.indexOf("recordCronRun({");
    expect(unauthIdx).toBeGreaterThan(0);
    expect(recordIdx).toBeGreaterThan(unauthIdx);
  });

  it("the table is FK-free and separate from webhook_failures", () => {
    const migration = readFileSync(
      join(ROOT, "supabase/migrations/20260730130000_cron_runs.sql"),
      "utf-8",
    );
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS cron_runs");
    // Same rule as install_events: an FK here would let a redact cascade
    // delete the operational history.
    expect(migration).not.toMatch(/REFERENCES\s+\w+/i);
    // Bootstrap parity.
    const schema = readFileSync(join(ROOT, "supabase/schema.sql"), "utf-8");
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS cron_runs");
  });

  it("recordCronRun swallows its own failures", async () => {
    vi.doMock("../app/supabase.server", () => ({
      supabase: {
        from: () => ({
          insert: async () => {
            throw new Error("db down");
          },
        }),
      },
    }));
    vi.resetModules();
    const { recordCronRun } = await import("../app/lib/cron-runs.server");
    await expect(
      recordCronRun({ job: "x", startedAt: Date.now(), ok: true, summary: {} }),
    ).resolves.toBeUndefined();
    vi.doUnmock("../app/supabase.server");
  });
});
