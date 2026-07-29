/**
 * tests/trust-fix-failure-modes.test.ts
 *
 * BEHAVIOURAL proof for the fix to the defect that churned three paying
 * merchants: a failed Shopify Admin API policy fetch was indistinguishable from
 * "this shop has no policies", so four checks reported CRITICAL at once.
 *
 * These tests FORCE each real failure mode rather than asserting on source text:
 *   1. a GraphQL response carrying `errors` with no data (the ACCESS_DENIED /
 *      401-shaped body that caused the original bug)
 *   2. a transport failure (executor throws)
 *   3. a 401 from an expired offline token (surfaces as a throw — this is
 *      literally how graphql-client.server.ts reports it: "HTTP 401 from <shop>")
 *   4. a timeout (AbortError — also a throw)
 *
 * and then drive the whole orchestrator to assert what the MERCHANT ends up
 * seeing: non-scorable info, excluded from both sides of the score, and a
 * scan_data_availability row.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ─── Mutable fixtures the mocks read ────────────────────────────────────────
let policiesAvailable = true;
let pagesAvailable = true;
/**
 * Products were the last Admin-API source with no availability flag. An empty
 * catalog from a throttle or a stale-token 401 made every product-derived check
 * pass vacuously, scoring a store HIGHER than it earned.
 */
let productsAvailable = true;
let prevScan: { compliance_score: number; critical_count: number; created_at: string } | null = null;
let prevScanThrows = false;
let insertedViolations: Array<Record<string, unknown>> = [];
let insertedScan: Record<string, unknown> | null = null;
let sentryMessages: Array<{ msg: string; level?: string }> = [];

// ─── Mocks ──────────────────────────────────────────────────────────────────
vi.mock("../app/supabase.server", () => {
  const makeChain = (table: string) => {
    const ctx: { mode?: string; payload?: unknown } = {};
    const chain: Record<string, (...a: any[]) => any> = {
      select: () => chain,
      eq: () => chain,
      neq: () => chain,
      is: () => chain,
      not: () => chain,
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      update: (p: unknown) => { ctx.mode = "update"; ctx.payload = p; return chain; },
      insert: (p: unknown) => { ctx.mode = "insert"; ctx.payload = p; return chain; },
      maybeSingle: async () => {
        if (table === "scans") {
          if (prevScanThrows) throw new Error("simulated supabase failure reading previous scan");
          return { data: prevScan, error: null };
        }
        return { data: null, error: null };
      },
      single: async () => {
        if (table === "scans" && ctx.mode === "insert") {
          insertedScan = ctx.payload as Record<string, unknown>;
          return { data: { id: "scan-under-test", ...insertedScan }, error: null };
        }
        return { data: null, error: null };
      },
      // Terminal for `.insert(rows).select()` (violations) and the awaited
      // fire-and-forget `.update(...).eq(...)` metadata refresh.
      then: (resolve: (v: unknown) => void) => {
        if (ctx.mode === "insert" && table === "violations") {
          insertedViolations = ctx.payload as Array<Record<string, unknown>>;
          return resolve({ data: insertedViolations, error: null });
        }
        return resolve({ data: null, error: null });
      },
    };
    return chain;
  };
  return { supabase: { from: (t: string) => makeChain(t) } };
});

vi.mock("../app/lib/sentry.server", () => ({
  sentry: {
    captureMessage: (msg: string, level?: string) => { sentryMessages.push({ msg, level }); },
    captureException: () => {},
    addBreadcrumb: () => {},
  },
}));

vi.mock("../app/lib/checks/helpers.server", async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    // Storefront always reachable so it cannot confound the policy assertions.
    fetchPublicPage: vi.fn(async () => ({ status: 200, html: "<html><body>ok</body></html>" })),
  };
});

// PageSpeed would make a real external call; pin it to a non-scorable info so it
// never flakes and never pollutes the score denominator.
vi.mock("../app/lib/checks/page-speed.server", () => ({
  checkPageSpeed: vi.fn(async () => ({
    check_name: "page_speed",
    passed: true,
    severity: "info" as const,
    scorable: false,
    title: "Page Speed — Not Measured",
    description: "stub",
    fix_instruction: "-",
    raw_data: {},
  })),
}));

vi.mock("../app/lib/shopify-api.server", () => ({
  createAdminClient: vi.fn(async () => vi.fn()),
  getShopInfo: vi.fn(async () => ({
    name: "Test Store",
    contactEmail: "hi@test.com",
    billingAddress: { address1: "1 St", city: "X", province: "Y", country: "GB", zip: "1" },
    myshopifyDomain: "test.myshopify.com",
    currencyCode: "GBP",
    primaryDomain: { url: "https://test.com", host: "test.com" },
    shopOwnerName: "O", ianaTimezone: "UTC", createdAt: "2026-01-01T00:00:00Z",
    plan: { displayName: "Basic", shopifyPlus: false, partnerDevelopment: false },
  })),
  getShopPolicies: vi.fn(async () =>
    policiesAvailable
      ? {
          REFUND_POLICY: { type: "REFUND_POLICY", title: "Refund", url: "u", body: "Returns accepted within 30 days if unused in original packaging. Refund to original payment method within 14 days." },
          PRIVACY_POLICY: { type: "PRIVACY_POLICY", title: "Privacy", url: "u", body: "We collect data." },
          TERMS_OF_SERVICE: { type: "TERMS_OF_SERVICE", title: "Terms", url: "u", body: "Terms apply." },
          SHIPPING_POLICY: { type: "SHIPPING_POLICY", title: "Shipping", url: "u", body: "Ships in 3-7 business days. Free shipping over 50." },
          all: [], available: true,
        }
      : { REFUND_POLICY: null, PRIVACY_POLICY: null, TERMS_OF_SERVICE: null, SHIPPING_POLICY: null, all: [], available: false },
  ),
  getProducts: vi.fn(async () => []),
  getPages: vi.fn(async () => []),
  // The orchestrator reads pages through the availability-aware variant so a
  // failed Pages fetch cannot be read as "this shop has no policy pages".
  getPagesWithAvailability: vi.fn(async () => ({ pages: [], available: pagesAvailable })),
  // Same contract for products. `available: true` here means these tests keep
  // exercising the POLICY degradation path specifically — a products-driven
  // degrade would otherwise confound the assertions below. The
  // products-unavailable path has its own coverage.
  getProductsWithAvailability: vi.fn(async () => ({
    products: [],
    available: productsAvailable,
  })),
}));

import { runComplianceScan } from "../app/lib/checks/index.server";
import { computeComplianceScore } from "../app/lib/checks/compliance-score";

const POLICY_CHECKS = ["refund_return_policy", "shipping_policy", "privacy_and_terms"];

// ════════════════════════════════════════════════════════════════════════════
// PART 1 — getShopPolicies against each forced failure mode.
// Uses the REAL implementation via vi.importActual so the mock above (needed by
// the orchestrator tests) does not hide the thing under test.
// ════════════════════════════════════════════════════════════════════════════
describe("getShopPolicies: every failure mode yields available:false", () => {
  async function realImpl() {
    const mod = await vi.importActual<typeof import("../app/lib/shopify-api.server")>(
      "../app/lib/shopify-api.server",
    );
    return mod.getShopPolicies;
  }

  it("GraphQL errors with no data → retry fires EXACTLY once, available:false", async () => {
    const getShopPolicies = await realImpl();
    const calls: unknown[] = [];
    // Non-throttled error body — the ACCESS_DENIED / expired-token shape.
    const executor = vi.fn(async () => {
      calls.push(1);
      return { errors: [{ message: "Access denied", extensions: { code: "ACCESS_DENIED" } }] };
    });

    const res = await getShopPolicies(executor as never);

    expect(res.available).toBe(false);
    // 1 initial + 1 bounded retry. executeWithRetry only loops on THROTTLED,
    // so a non-throttled error body means each call is exactly one round trip.
    expect(calls.length).toBe(2);
    expect(res.REFUND_POLICY).toBeNull();
    expect(res.SHIPPING_POLICY).toBeNull();
  });

  it("a response that succeeds ON THE RETRY is reported available:true", async () => {
    const getShopPolicies = await realImpl();
    let n = 0;
    const executor = vi.fn(async () => {
      n++;
      if (n === 1) return { errors: [{ message: "boom" }] };
      return {
        data: { shop: { shopPolicies: [{ type: "REFUND_POLICY", title: "R", url: "u", body: "b" }] } },
      };
    });

    const res = await getShopPolicies(executor as never);

    expect(n).toBe(2);
    expect(res.available).toBe(true);
    expect(res.REFUND_POLICY).not.toBeNull();
  });

  it("transport failure (executor throws) → available:false", async () => {
    const getShopPolicies = await realImpl();
    const executor = vi.fn(async () => { throw new Error("ECONNRESET"); });
    const res = await getShopPolicies(executor as never);
    expect(res.available).toBe(false);
  });

  it("401 from an expired offline token → available:false", async () => {
    const getShopPolicies = await realImpl();
    // graphql-client.server.ts surfaces this as a throw: "HTTP 401 from <shop>".
    const executor = vi.fn(async () => { throw new Error("HTTP 401 from test.myshopify.com"); });
    const res = await getShopPolicies(executor as never);
    expect(res.available).toBe(false);
  });

  it("timeout → available:false", async () => {
    const getShopPolicies = await realImpl();
    const executor = vi.fn(async () => {
      const e = new Error("The operation was aborted due to timeout");
      e.name = "TimeoutError";
      throw e;
    });
    const res = await getShopPolicies(executor as never);
    expect(res.available).toBe(false);
  });

  // DOCUMENTED GAP, asserted so it cannot change silently. The bounded retry
  // only guards the errors-with-no-data branch; a THROW short-circuits to the
  // outer catch, and executeWithRetry does not retry throws either (it loops
  // only on THROTTLED). So a transient network blip or a timeout gets ZERO
  // retries. It still degrades correctly — available:false, non-scorable info,
  // no fabricated criticals — so it cannot recreate the original bug. Widening
  // the retry to cover throws is a separate decision.
  it("throws get NO retry (documented gap): exactly one round trip", async () => {
    const getShopPolicies = await realImpl();
    let n = 0;
    const executor = vi.fn(async () => { n++; throw new Error("ECONNRESET"); });
    await getShopPolicies(executor as never);
    expect(n).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PART 2 — what the MERCHANT sees. Drives the real orchestrator.
// ════════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════════
// An unreadable CATALOG must not be scored as a compliant one.
//
// getProducts() was the last Admin-API source with no availability flag: it
// logged GraphQL errors and then did `result.data?.products?.edges ?? []`, so a
// THROTTLE, a 5xx, or an ACCESS_DENIED on one of the 38 live expired tokens all
// became "this store has zero products". The product-derived checks then passed
// vacuously and the merchant got a BETTER score than they earned — the
// direction §11a calls the most dangerous, because nobody investigates good
// news.
// ════════════════════════════════════════════════════════════════════════════
describe("orchestrator: an unreadable catalog never becomes a clean score", () => {
  const PRODUCT_CHECKS = [
    "product_data_quality",
    "structured_data_json_ld",
    "image_hosting_audit",
  ];

  beforeEach(() => {
    policiesAvailable = true;
    pagesAvailable = true;
    productsAvailable = true;
    prevScan = null;
    prevScanThrows = false;
    insertedViolations = [];
    insertedScan = null;
    sentryMessages = [];
  });

  it("BASELINE — an available (if empty) catalog scores the product checks normally", async () => {
    productsAvailable = true;
    await runComplianceScan("m1", "test.myshopify.com", "manual");
    for (const name of PRODUCT_CHECKS) {
      const row = insertedViolations.find((v) => v.check_name === name);
      if (row) expect(row.raw_data, `${name} wrongly degraded`).not.toHaveProperty("degraded");
    }
  });

  it("an unavailable catalog degrades the product checks to non-scorable info", async () => {
    productsAvailable = false;
    await runComplianceScan("m1", "test.myshopify.com", "manual");

    for (const name of PRODUCT_CHECKS) {
      const row = insertedViolations.find((v) => v.check_name === name);
      expect(row, `${name} missing from results`).toBeDefined();
      expect(row!.raw_data, `${name} not degraded`).toMatchObject({ degraded: true });
      expect(row!.severity, `${name} still scored as a failure`).toBe("info");
    }
  });

  it("an unavailable catalog cannot inflate the compliance score", async () => {
    productsAvailable = false;
    await runComplianceScan("m1", "test.myshopify.com", "manual");
    // Degraded checks are excluded from BOTH sides of the ratio, exactly as a
    // PageSpeed timeout is. A vacuous pass would instead have counted toward
    // the numerator AND the denominator and pushed the score up.
    const degradedProductChecks = insertedViolations.filter(
      (v) =>
        PRODUCT_CHECKS.includes(v.check_name as string) &&
        (v.raw_data as Record<string, unknown> | null)?.degraded === true,
    );
    expect(degradedProductChecks.length).toBe(PRODUCT_CHECKS.length);
    for (const row of degradedProductChecks) {
      // passed:true + severity:info + scorable:false is what excludes a row from
      // both sides of the ratio. A degraded row left at passed:false would still
      // count against the merchant for something we never managed to read.
      expect(row.passed, `${row.check_name} degraded but still counted as failed`).toBe(true);
    }
  });
});

describe("orchestrator: unavailable policy data never becomes a finding", () => {
  beforeEach(() => {
    policiesAvailable = true;
    pagesAvailable = true;
    productsAvailable = true;
    prevScan = null;
    prevScanThrows = false;
    insertedViolations = [];
    insertedScan = null;
    sentryMessages = [];
  });

  it("BASELINE — when policies ARE available the three checks are scored normally", async () => {
    policiesAvailable = true;
    await runComplianceScan("m1", "test.myshopify.com", "manual");

    for (const name of POLICY_CHECKS) {
      const row = insertedViolations.find((v) => v.check_name === name)!;
      expect(row, `${name} missing`).toBeDefined();
      expect(row.raw_data).not.toHaveProperty("degraded");
    }
    expect(insertedViolations.find((v) => v.check_name === "scan_data_availability")).toBeUndefined();
  });

  it("all three policy checks emit NON-SCORABLE info, not a failure", async () => {
    policiesAvailable = false;
    await runComplianceScan("m1", "test.myshopify.com", "manual");

    for (const name of POLICY_CHECKS) {
      const row = insertedViolations.find((v) => v.check_name === name)!;
      expect(row, `${name} missing`).toBeDefined();
      expect(row.severity, `${name} severity`).toBe("info");
      expect(row.passed, `${name} passed`).toBe(true);
      expect(String(row.title)).toMatch(/Not Checked$/);
      // The merchant must be told it is our side, not theirs.
      expect(String(row.description)).toMatch(/could not read/i);
      expect(String(row.description)).toMatch(/not affected your score/i);
      expect((row.raw_data as Record<string, unknown>).degraded).toBe(true);
      expect((row.raw_data as Record<string, unknown>).degraded_reason).toBe(
        "shopify_admin_api_unavailable",
      );
    }
  });

  it("NO critical is emitted anywhere — this is the churn bug's exact signature", async () => {
    policiesAvailable = false;
    await runComplianceScan("m1", "test.myshopify.com", "manual");

    const criticals = insertedViolations.filter((v) => v.severity === "critical");
    expect(criticals).toEqual([]);
    // The persisted scan row must not report the 4-critical signature either.
    expect(insertedScan!.critical_count).toBe(0);
  });

  // The decisive three-way comparison. `total_checks` on the scans row is the
  // raw check count (always 12) and is NOT the scorable denominator — the
  // denominator lives in computeComplianceScore().scorableTotal and is not
  // persisted — so the honest assertion is on the SCORE itself.
  it("the score excludes them from BOTH sides — proven three ways", async () => {
    // (a) policies present and complete → everything passes.
    policiesAvailable = true;
    await runComplianceScan("m1", "test.myshopify.com", "manual");
    const healthyScore = Number(insertedScan!.compliance_score);

    // (b) policies UNAVAILABLE → the three checks are excluded, NOT counted as
    //     failures, so the score must be UNCHANGED from (a). If the degradation
    //     were wrong they would land in the denominator as failures and drag it
    //     down to roughly 8/11 = 72.7.
    insertedViolations = []; insertedScan = null;
    policiesAvailable = false;
    await runComplianceScan("m1", "test.myshopify.com", "manual");
    const degradedScore = Number(insertedScan!.compliance_score);
    expect(degradedScore).toBe(healthyScore);

    // (c) policies AVAILABLE but genuinely empty → a real finding, and the score
    //     MUST drop. This is what proves (b) is degradation and not a blanket
    //     "never fail the policy checks".
    insertedViolations = []; insertedScan = null;
    policiesAvailable = true;
    const api = await import("../app/lib/shopify-api.server");
    vi.mocked(api.getShopPolicies).mockResolvedValueOnce({
      REFUND_POLICY: null, PRIVACY_POLICY: null, TERMS_OF_SERVICE: null,
      SHIPPING_POLICY: null, all: [], available: true,
    } as never);
    await runComplianceScan("m1", "test.myshopify.com", "manual");
    const realFailureScore = Number(insertedScan!.compliance_score);
    expect(realFailureScore).toBeLessThan(degradedScore);
    expect(Number(insertedScan!.critical_count)).toBeGreaterThan(0);

    // And the scorer's own arithmetic, directly.
    const scored = computeComplianceScore([
      { passed: true, severity: "info", scorable: false }, // excluded entirely
      { passed: false, severity: "critical" },
      { passed: true, severity: "info" },
    ]);
    expect(scored.scorableTotal).toBe(2);
    expect(scored.scorablePassed).toBe(1);
    expect(scored.complianceScore).toBe(50);
  });

  it("a scan_data_availability row appears, naming the skipped checks", async () => {
    policiesAvailable = false;
    await runComplianceScan("m1", "test.myshopify.com", "manual");

    const marker = insertedViolations.find((v) => v.check_name === "scan_data_availability")!;
    expect(marker).toBeDefined();
    expect(marker.severity).toBe("info");
    expect(String(marker.title)).toMatch(/Partial Scan/);
    const skipped = (marker.raw_data as { skipped_checks: string[] }).skipped_checks;
    for (const name of POLICY_CHECKS) expect(skipped).toContain(name);
  });

  it("a DEGRADED Sentry message is emitted", async () => {
    policiesAvailable = false;
    await runComplianceScan("m1", "test.myshopify.com", "manual");
    expect(sentryMessages.some((m) => /Scan DEGRADED/.test(m.msg))).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PART 3 — the collapse alarm.
// ════════════════════════════════════════════════════════════════════════════
describe("collapse alarm", () => {
  beforeEach(() => {
    policiesAvailable = true;
    pagesAvailable = true;
    prevScan = null;
    prevScanThrows = false;
    insertedViolations = [];
    insertedScan = null;
    sentryMessages = [];
  });

  const collapse = () => sentryMessages.filter((m) => /IMPLAUSIBLE SCORE COLLAPSE/.test(m.msg));

  it("fires on a >20 point drop", async () => {
    // Force a genuinely low-scoring run (policies AVAILABLE but empty → real
    // criticals) against a previous scan of 100. A healthy run scores 100, so it
    // could never produce a 20-point drop no matter what `prevScan` claims.
    const api = await import("../app/lib/shopify-api.server");
    vi.mocked(api.getShopPolicies).mockResolvedValueOnce({
      REFUND_POLICY: null, PRIVACY_POLICY: null, TERMS_OF_SERVICE: null,
      SHIPPING_POLICY: null, all: [], available: true,
    } as never);
    prevScan = { compliance_score: 100, critical_count: 2, created_at: "2026-07-01T00:00:00Z" };

    await runComplianceScan("m1", "test.myshopify.com", "manual");

    const score = Number(insertedScan!.compliance_score);
    expect(100 - score).toBeGreaterThan(20); // precondition
    // prevCrit is 2, so the critical-jump arm cannot fire — this isolates the
    // score-drop arm.
    expect(collapse().length).toBe(1);
    expect(collapse()[0].level).toBe("warning");
    expect(collapse()[0].msg).toMatch(/drop 2[0-9]\./);
  });

  it("does NOT fire on a small drop", async () => {
    await runComplianceScan("m1", "test.myshopify.com", "manual");
    const score = Number(insertedScan!.compliance_score);
    insertedViolations = []; insertedScan = null; sentryMessages = [];
    prevScan = { compliance_score: score + 5, critical_count: 0, created_at: "2026-07-01T00:00:00Z" };
    await runComplianceScan("m1", "test.myshopify.com", "manual");
    expect(collapse()).toEqual([]);
  });

  // The historical signature was 0 -> FOUR criticals. Since contact_information
  // was demoted to a 1-of-N warning on 2026-07-09, this failure mode now tops out
  // at THREE, which is why the alarm threshold is 3 and not 4. Forcing the failure
  // is what exposed that; a code review would not have.
  it("fires on 0 → 3+ criticals (the post-demotion signature)", async () => {
    const api = await import("../app/lib/shopify-api.server");
    vi.mocked(api.getShopPolicies).mockResolvedValueOnce({
      REFUND_POLICY: null, PRIVACY_POLICY: null, TERMS_OF_SERVICE: null,
      SHIPPING_POLICY: null, all: [], available: true,
    } as never);
    prevScan = { compliance_score: 100, critical_count: 0, created_at: "2026-07-01T00:00:00Z" };

    await runComplianceScan("m1", "test.myshopify.com", "manual");

    const crit = Number(insertedScan!.critical_count);
    expect(crit).toBeGreaterThanOrEqual(3);
    expect(collapse().length).toBe(1);
    expect(collapse()[0].msg).toMatch(/criticals 0 -> [3-9]/);
  });

  // Guards the threshold itself: if someone raises it back to 4, the arm goes
  // dead again for the only failure mode it exists to catch.
  it("the critical-jump threshold is reachable by the current check severities", async () => {
    const src = readFileSync(
      join(__dirname, "..", "app", "lib", "checks", "index.server.ts"),
      "utf8",
    );
    const m = src.match(/CRITICAL_JUMP_ALARM\s*=\s*(\d+)/);
    expect(m).not.toBeNull();
    // Only three checks can emit `critical` from a policy-data failure today.
    expect(Number(m![1])).toBeLessThanOrEqual(3);
  });

  it("no previous scan → no alarm, no crash", async () => {
    prevScan = null;
    await runComplianceScan("m1", "test.myshopify.com", "manual");
    expect(collapse()).toEqual([]);
    expect(insertedScan).not.toBeNull();
  });

  it("a THROW inside the alarm cannot fail the scan", async () => {
    prevScanThrows = true;
    const res = await runComplianceScan("m1", "test.myshopify.com", "manual");
    // Scan still completed and persisted.
    expect(res.scan).toBeDefined();
    expect(insertedScan).not.toBeNull();
    expect(insertedViolations.length).toBeGreaterThan(0);
    expect(collapse()).toEqual([]);
  });
});
