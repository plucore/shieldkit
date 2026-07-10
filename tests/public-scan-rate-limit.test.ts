/**
 * Behavioral test for the public POST /scan per-IP rate limit (STEP 4 of the
 * Vercel CPU mitigations). The public scanner is unauthenticated and each scan
 * fetches + cheerio-parses several pages against an attacker-supplied URL, so it
 * must cap requests per client IP.
 *
 * We import the real `action` and the real rate-limiter (in-memory fallback
 * path), mocking only the boundaries: the scan engine (to assert it does/doesn't
 * run), Supabase (forced into the in-memory fallback + no module-load throw),
 * and the marketing React components (so importing the route is side-effect-free).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { runPublicScanMock } = vi.hoisted(() => ({ runPublicScanMock: vi.fn() }));

vi.mock("../app/lib/checks/public-scanner.server", () => ({
  runPublicScan: runPublicScanMock,
}));
vi.mock("../app/lib/checks/public-risk-score", () => ({
  computeRiskScore: () => 50,
}));
vi.mock("../app/components/marketing/MarketingLayout", () => ({
  MarketingLayout: () => null,
}));
vi.mock("../app/components/marketing/Button", () => ({
  MarketingButton: () => null,
}));
vi.mock("../app/components/marketing/JsonLd", () => ({
  JsonLd: () => null,
}));
// Force the rate-limiter's in-memory fallback (queries/inserts return an error)
// and make the leads writes harmless. Also stops supabase.server throwing at
// module load for lack of env.
vi.mock("../app/supabase.server", () => {
  const err = { message: "no scan_rate_limits table (test)" };
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: () => chain,
    eq: () => chain,
    gte: () => chain,
    lt: () => chain,
    delete: () => chain,
    update: () => chain,
    order: () => Promise.resolve({ data: null, error: err }),
    insert: () => Promise.resolve({ error: err }),
    upsert: () => Promise.resolve({ error: null }),
    then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve({ data: null, error: null }).then(onF, onR),
  });
  return { supabase: { from: () => chain } };
});

import { action } from "../app/routes/scan";
import { PUBLIC_SCAN_RATE_LIMIT_MAX } from "../app/lib/rate-limiter.server";

function scanRequest(ip: string): Request {
  return new Request("http://localhost/scan", {
    method: "POST",
    headers: {
      "x-forwarded-for": ip,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      intent: "scan",
      url: "https://teststore.myshopify.com",
    }).toString(),
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (request: Request) => action({ request, params: {}, context: {} } as any);

describe("public POST /scan — per-IP rate limiting", () => {
  beforeEach(() => {
    runPublicScanMock.mockReset();
    runPublicScanMock.mockResolvedValue({
      ok: true,
      store_url: "https://teststore.myshopify.com",
      scanned_at: "2026-07-09T00:00:00.000Z",
      score: 100,
      threat_level: "Minimal",
      summary: {
        total_checks: 8,
        passed_checks: 8,
        critical_count: 0,
        warning_count: 0,
        errored_checks: 0,
      },
      results: [],
    });
  });

  it(`allows ${PUBLIC_SCAN_RATE_LIMIT_MAX} scans from one IP, then 429s the next without running it`, async () => {
    // TEST-NET-3 address, unique to this test so the in-memory bucket is clean.
    const ip = "203.0.113.42";
    const N = PUBLIC_SCAN_RATE_LIMIT_MAX;

    for (let i = 0; i < N; i++) {
      const res = (await call(scanRequest(ip))) as { intent: string };
      expect(res.intent).toBe("scan");
    }
    expect(runPublicScanMock).toHaveBeenCalledTimes(N);

    // The (N+1)th request from the same IP is blocked.
    const blocked = (await call(scanRequest(ip))) as {
      constructor: { name: string };
      init: { status: number };
      data: { intent: string; error: string };
    };

    // The scan engine was NOT invoked for the blocked request.
    expect(runPublicScanMock).toHaveBeenCalledTimes(N);
    // Returned as a 429 via the RR `data()` helper with a friendly error.
    expect(blocked.constructor.name).toBe("DataWithResponseInit");
    expect(blocked.init.status).toBe(429);
    expect(blocked.data.intent).toBe("error");
    expect(blocked.data.error).toMatch(/try again/i);
  });

  it("rate-limits each IP independently", async () => {
    const ipA = "203.0.113.50";
    const ipB = "203.0.113.51";

    // Exhaust ipA's quota.
    for (let i = 0; i < PUBLIC_SCAN_RATE_LIMIT_MAX; i++) {
      await call(scanRequest(ipA));
    }
    const blockedA = (await call(scanRequest(ipA))) as { init?: { status: number } };
    expect(blockedA.init?.status).toBe(429);

    // A different IP still gets through.
    const okB = (await call(scanRequest(ipB))) as { intent: string };
    expect(okB.intent).toBe("scan");
  });
});
