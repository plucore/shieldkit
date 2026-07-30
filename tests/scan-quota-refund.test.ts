/**
 * tests/scan-quota-refund.test.ts
 *
 * BEHAVIOURAL proof for the scan-quota refund off-by-one.
 *
 * THE BUG. Both scan entry points refunded a failed scan with an ABSOLUTE
 * write computed from a value read BEFORE the decrement:
 *
 *     .update({ scans_remaining: (scansRemaining ?? 0) + 1 })
 *
 * The RPC had already moved the row to `scansRemaining - 1`, so restoring
 * should write `scansRemaining`. Writing `scansRemaining + 1` handed back one
 * MORE scan than was consumed — every failed scan net-granted a free one.
 *
 * Found in production, not in review: western-grace-collective was granted 1
 * scan (the DB DEFAULT), ran exactly 1 scan, and sat at scans_remaining = 2
 * with scans_reset_at still equal to created_at (so no demote path had touched
 * it). Nothing else in the codebase can write a 2.
 *
 * These tests drive the REAL route action with a supabase mock whose RPCs
 * implement the actual SQL semantics against an in-memory row, so they assert
 * the merchant-visible outcome rather than the source text.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");

// ─── The row under test ──────────────────────────────────────────────────────
let scansRemaining: number | null = 1;
let scanShouldThrow = false;
let rpcCalls: string[] = [];
/** Absolute writes to merchants.scans_remaining — must stay empty. */
let absoluteWrites: unknown[] = [];

/**
 * Faithful JS port of the two RPCs' SQL, so the test exercises the same
 * arithmetic the database will run.
 */
function decrementRpc(): Array<{ new_scans_remaining: number }> {
  // WHERE scans_remaining IS NOT NULL AND scans_remaining > 0
  if (scansRemaining === null || scansRemaining <= 0) return [];
  scansRemaining -= 1;
  return [{ new_scans_remaining: scansRemaining }];
}

function refundRpc(cap = 1): Array<{ new_scans_remaining: number }> {
  // WHERE scans_remaining IS NOT NULL
  if (scansRemaining === null) return [];
  // SET scans_remaining = LEAST(x + 1, GREATEST(cap, x))
  scansRemaining = Math.min(scansRemaining + 1, Math.max(cap, scansRemaining));
  return [{ new_scans_remaining: scansRemaining }];
}

vi.mock("../app/supabase.server", () => {
  const makeChain = (table: string) => {
    const ctx: { mode?: string; payload?: any } = {};
    const chain: Record<string, (...a: any[]) => any> = {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      not: () => chain,
      order: () => chain,
      limit: () => chain,
      update: (p: any) => {
        ctx.mode = "update";
        ctx.payload = p;
        if (table === "merchants" && p && "scans_remaining" in p) {
          // The defect's signature: any absolute write of the quota column.
          absoluteWrites.push(p);
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
      then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null, count: 0 }),
    };
    return chain;
  };
  return {
    supabase: {
      from: (t: string) => makeChain(t),
      rpc: async (name: string, args?: Record<string, unknown>) => {
        rpcCalls.push(name);
        if (name === "decrement_scan_quota") return { data: decrementRpc(), error: null };
        if (name === "refund_scan_quota") {
          const cap = (args?.p_cap as number | undefined) ?? 1;
          return { data: refundRpc(cap), error: null };
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
    if (scanShouldThrow) throw new Error("HTTP 401 from test.myshopify.com");
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
  scanShouldThrow = false;
  rpcCalls = [];
  absoluteWrites = [];
});

async function postScan() {
  const { action } = await import("../app/routes/api.scan");
  // The route only ever reads `request`; params/context are structural filler.
  // Cast through the action's own parameter type so this stays correct if
  // React Router's ActionFunctionArgs shape changes.
  const args = {
    request: new Request("https://x/api/scan", { method: "POST" }),
    params: {},
    context: {},
  } as unknown as Parameters<typeof action>[0];
  return action(args);
}

describe("failed scan refunds EXACTLY what it consumed", () => {
  it("1 -> decrement -> throw -> refund leaves the row at 1 (not 2)", async () => {
    scanShouldThrow = true;
    const res = await postScan();

    expect(res.status).toBe(500);
    // The whole point. Pre-fix this was 2 and the merchant gained a free scan.
    expect(scansRemaining).toBe(1);
    expect(rpcCalls).toContain("decrement_scan_quota");
    expect(rpcCalls).toContain("refund_scan_quota");
    // No absolute write to the quota column anywhere on the path.
    expect(absoluteWrites).toEqual([]);
  });

  it("repeated failures cannot inflate the quota", async () => {
    scanShouldThrow = true;
    for (let i = 0; i < 5; i++) await postScan();
    // Five failures, five decrement+refund pairs, still exactly one scan.
    expect(scansRemaining).toBe(1);
    expect(absoluteWrites).toEqual([]);
  });

  it("a successful scan still consumes the quota (no refund fires)", async () => {
    const res = await postScan();
    expect(res.status).toBe(200);
    expect(scansRemaining).toBe(0);
    expect(rpcCalls).not.toContain("refund_scan_quota");
  });

  it("an exhausted merchant is blocked before the scan and nothing is refunded", async () => {
    scansRemaining = 0;
    const res = await postScan();
    expect(res.status).toBe(402);
    expect(scansRemaining).toBe(0);
    expect(rpcCalls).not.toContain("refund_scan_quota");
  });

  it("a paid merchant (NULL) is never touched by either RPC", async () => {
    scansRemaining = null;
    scanShouldThrow = true;
    await postScan();
    expect(scansRemaining).toBeNull();
    expect(rpcCalls).not.toContain("decrement_scan_quota");
    expect(rpcCalls).not.toContain("refund_scan_quota");
  });
});

describe("refund_scan_quota cap semantics", () => {
  it("raises toward the cap but never lowers an existing value", () => {
    const run = (start: number | null, cap = 1) => {
      scansRemaining = start;
      refundRpc(cap);
      return scansRemaining;
    };
    expect(run(0)).toBe(1); // normal refund after a decrement
    expect(run(1)).toBe(1); // no-op — this is the 1 -> 2 bug, now impossible
    // A manual grant must never be confiscated. A bare LEAST(x + 1, 1) would
    // slash this to 1; GREATEST(cap, x) is what prevents that.
    expect(run(4)).toBe(4);
    expect(run(null)).toBeNull(); // unlimited/paid untouched
  });
});

describe("neither entry point writes the quota absolutely", () => {
  const files = ["app/routes/app._index.tsx", "app/routes/api.scan.ts"];

  it.each(files)("%s refunds via the RPC, not an absolute + 1", (rel) => {
    const src = readFileSync(join(ROOT, rel), "utf-8");
    expect(src).toContain('rpc("refund_scan_quota"');
    // The exact defect shape: an absolute write derived from the pre-decrement
    // read. Any reappearance of this is the bug coming back.
    expect(src).not.toMatch(/scans_remaining:\s*\(scansRemaining[^)]*\)\s*\+\s*1/);
    expect(src).not.toMatch(/scans_remaining:\s*scansRemaining\s*\+\s*1/);
  });
});
