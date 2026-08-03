/**
 * tests/scan-quota-fallback.test.ts
 *
 * BEHAVIOURAL proof that a failed quota decrement REFUSES the scan.
 *
 * THE BUG. Both scan entry points handled an RPC error like this:
 *
 *     if (rpcError) {
 *       if (scansRemaining <= 0) return 402;   // only the already-exhausted
 *     }                                        // ...then fell through and scanned
 *
 * A merchant with quota left got their scan AND kept their quota. The free
 * tier is one scan; this turned it into an unlimited one — silently, with a
 * 200 response and no counter moving. It is §11a of claude.md in the billing
 * layer: "we could not consume the quota" became "no quota needed consuming".
 *
 * The production shape it produces is unmistakable and was sitting in the DB:
 * 47 free merchants holding a full scans_remaining = 1 while having run
 * 98 scans between them, 33 of them with scans_reset_at still exactly equal to
 * created_at — so nothing had reset them, the decrement simply never ran.
 *
 * Restoring either fall-through fails the first test in each block below.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── The row under test ──────────────────────────────────────────────────────
let scansRemaining: number | null = 1;
let rpcShouldError = false;
let scansRun = 0;

vi.mock("../app/supabase.server", () => {
  const makeChain = (table: string) => {
    const chain: Record<string, (...a: any[]) => any> = {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      not: () => chain,
      order: () => chain,
      limit: () => chain,
      update: (p: any) => {
        if (table === "merchants" && p && "scans_remaining" in p) {
          scansRemaining = p.scans_remaining;
        }
        return chain;
      },
      insert: () => chain,
      maybeSingle: async () => {
        if (table === "merchants") {
          return {
            data: {
              id: "merchant-1",
              shopify_domain: "test.myshopify.com",
              scans_remaining: scansRemaining,
              tier: "free",
            },
            error: null,
          };
        }
        return { data: null, error: null };
      },
      then: (resolve: (v: unknown) => void) =>
        resolve({ data: null, error: null, count: 0 }),
    };
    return chain;
  };
  return {
    supabase: {
      from: (t: string) => makeChain(t),
      rpc: async (name: string) => {
        if (name === "decrement_scan_quota") {
          if (rpcShouldError) {
            return { data: null, error: { message: "connection reset" } };
          }
          if (scansRemaining === null || scansRemaining <= 0) {
            return { data: [], error: null };
          }
          scansRemaining -= 1;
          return { data: [{ new_scans_remaining: scansRemaining }], error: null };
        }
        return { data: null, error: null };
      },
    },
  };
});

vi.mock("../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop: "test.myshopify.com" } }),
  },
}));

vi.mock("../app/lib/compliance-scanner.server", () => ({
  runComplianceScan: async () => {
    scansRun += 1;
    return {
      scan: {
        id: "scan-1",
        compliance_score: 100,
        total_checks: 12,
        passed_checks: 12,
        critical_count: 0,
        warning_count: 0,
        info_count: 0,
      },
      violations: [],
    };
  },
}));

vi.mock("../app/lib/rate-limiter.server", () => ({
  checkRateLimit: async () => ({ allowed: true, remaining: 9, retryAfterSeconds: 0 }),
  recordScanRequest: async () => {},
  RATE_LIMIT_MAX_REQUESTS: 10,
}));

vi.mock("../app/lib/analytics.server", () => ({ captureEvent: async () => {} }));

beforeEach(() => {
  scansRemaining = 1;
  rpcShouldError = false;
  scansRun = 0;
});

async function postApiScan() {
  const { action } = await import("../app/routes/api.scan");
  const args = {
    request: new Request("https://x/api/scan", { method: "POST" }),
    params: {},
    context: {},
  } as unknown as Parameters<typeof action>[0];
  return action(args);
}

describe("POST /api/scan — decrement RPC failure", () => {
  it("refuses the scan instead of running it for free", async () => {
    rpcShouldError = true;
    const res = await postApiScan();

    // Pre-fix: 200, scansRun === 1, scansRemaining still 1 — a free scan that
    // cost the merchant nothing and could be repeated forever.
    expect(res.status).toBe(500);
    expect(scansRun).toBe(0);
    expect(scansRemaining).toBe(1);
  });

  it("cannot be farmed by retrying", async () => {
    rpcShouldError = true;
    for (let i = 0; i < 5; i++) await postApiScan();

    expect(scansRun).toBe(0);
    expect(scansRemaining).toBe(1);
  });

  it("still blocks an exhausted merchant with 402 when the RPC works", async () => {
    scansRemaining = 0;
    const res = await postApiScan();

    expect(res.status).toBe(402);
    expect(scansRun).toBe(0);
  });

  it("a healthy decrement still consumes the quota and scans", async () => {
    const res = await postApiScan();

    expect(res.status).toBe(200);
    expect(scansRun).toBe(1);
    expect(scansRemaining).toBe(0);
  });
});
