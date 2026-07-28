/**
 * tests/block1-fetch-degradation.test.ts
 *
 * BEHAVIOURAL proof for the three remaining instances of the root defect:
 * a failed fetch read as a factual negative.
 *
 *   1. public /scan policy fetch — collapsed 404 (honest) with 429/503/timeout
 *      (not) and emitted three CRITICALs. This is the lead-gen funnel.
 *   2. getPages — no availability flag; `[]` made "…or as a Shopify Page" a false
 *      assertion, and the policies retry widened the divergence.
 *   3. hidden_fee_detection — consumes shopPolicies from the SECOND check batch,
 *      which the degrade map never rewrote.
 *
 * Plus storefront_accessibility, which already fired wrongly in production
 * (normae-shop.com, 2026-04-20, a single transient HTTP 503).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyFetch } from "../app/lib/checks/public-scanner.server";
import { checkStorefrontAccessibility } from "../app/lib/checks/storefront-accessibility.server";
import { computeComplianceScore } from "../app/lib/checks/compliance-score";

// ════════════════════════════════════════════════════════════════════════════
// 1a. classifyFetch — the three-way distinction the old code did not make
// ════════════════════════════════════════════════════════════════════════════
describe("classifyFetch: 404 is a finding, 429/503/timeout are not", () => {
  const page = (status: number) => ({ status, html: "<html></html>" });

  it("200/204 → ok", () => {
    expect(classifyFetch(page(200))).toBe("ok");
    expect(classifyFetch(page(204))).toBe("ok");
  });

  it("404/410 → absent (the ONLY class allowed to become a failure)", () => {
    expect(classifyFetch(page(404))).toBe("absent");
    expect(classifyFetch(page(410))).toBe("absent");
  });

  it("429 rate-limited → unavailable, NOT absent", () => {
    expect(classifyFetch(page(429))).toBe("unavailable");
  });

  it("503 → unavailable — this is the normae-shop.com case", () => {
    expect(classifyFetch(page(503))).toBe("unavailable");
  });

  it("403 bot-challenge → unavailable", () => {
    expect(classifyFetch(page(403))).toBe("unavailable");
  });

  it("500/502/504 → unavailable", () => {
    for (const s of [500, 502, 504]) expect(classifyFetch(page(s))).toBe("unavailable");
  });

  it("null (timeout / DNS / reset) → unavailable", () => {
    expect(classifyFetch(null)).toBe("unavailable");
  });

  it("a 3xx that survived redirect:follow is unavailable, not absent", () => {
    expect(classifyFetch(page(301))).toBe("unavailable");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 1b. The public scanner end to end, with fetch forced into each failure mode.
// ════════════════════════════════════════════════════════════════════════════
describe("public /scan: an unfetchable policy page never becomes a critical", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => { globalThis.fetch = realFetch; });

  /**
   * Serve a storefront where everything works EXCEPT the policy pages, which are
   * forced into `mode`. products.json returns no products so the product-page
   * and PageSpeed paths stay quiet.
   */
  function installFetch(mode: "429" | "503" | "timeout" | "404") {
    let policyAttempts = 0;
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      const ok = (body: string, status = 200) =>
        new Response(body, { status, headers: { "content-type": "text/html" } });

      if (url.includes("/products.json")) return ok(JSON.stringify({ products: [] }), 200);
      if (url.includes("/policies/")) {
        policyAttempts++;
        if (mode === "timeout") throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
        if (mode === "404") return ok("not found", 404);
        return ok("rate limited", mode === "429" ? 429 : 503);
      }
      // Homepage / contact / about — a plausible storefront.
      return ok("<html><body><a href='mailto:hi@x.com'>mail</a> visa mastercard</body></html>");
    }) as never;
    return { attempts: () => policyAttempts };
  }

  async function run() {
    // Import fresh so the module picks up the patched global fetch.
    const mod = await import("../app/lib/checks/public-scanner.server");
    return mod.runPublicScan("https://example-store.com");
  }

  for (const mode of ["429", "503", "timeout"] as const) {
    it(`${mode}: the three policy checks degrade to NON-SCORABLE info, zero criticals`, async () => {
      installFetch(mode);
      const res = await run();
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      for (const name of ["shipping_policy", "refund_return_policy"]) {
        const r = res.results.find((x) => x.check_name === name)!;
        expect(r, `${name} missing`).toBeDefined();
        expect(r.severity, `${name} severity`).toBe("info");
        expect(r.passed, `${name} passed`).toBe(true);
        expect(r.scorable, `${name} scorable`).toBe(false);
        expect(r.title).toMatch(/Not Checked$/);
        expect((r.raw_data as Record<string, unknown>).degraded).toBe(true);
      }
      // The headline: no fabricated criticals anywhere.
      expect(res.results.filter((r) => !r.passed && r.severity === "critical")).toEqual([]);
      expect(res.summary.critical_count).toBe(0);
    });
  }

  it("404 still produces REAL criticals — degradation is not a blanket amnesty", async () => {
    installFetch("404");
    const res = await run();
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const shipping = res.results.find((r) => r.check_name === "shipping_policy")!;
    const refund = res.results.find((r) => r.check_name === "refund_return_policy")!;
    expect(shipping.passed).toBe(false);
    expect(shipping.severity).toBe("critical");
    expect(refund.passed).toBe(false);
    expect(refund.severity).toBe("critical");
    expect(res.summary.critical_count).toBeGreaterThanOrEqual(2);
  });

  it("the bounded retry fires for `unavailable` and NOT for a 404", async () => {
    const un = installFetch("503");
    await run();
    // 4 policy URLs, each attempted twice (initial + one bounded retry).
    expect(un.attempts()).toBe(8);

    const found = installFetch("404");
    await run();
    // 404 is a definitive answer — one attempt each, no retry.
    expect(found.attempts()).toBe(4);
  });

  it("a degraded run does not drag the headline score down", async () => {
    installFetch("503");
    const degraded = await run();
    installFetch("404");
    const real = await run();
    expect(degraded.ok && real.ok).toBe(true);
    if (!degraded.ok || !real.ok) return;
    // Same storefront, same everything except whether we could READ the policies.
    expect(degraded.score).toBeGreaterThan(real.score);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 1c. storefront_accessibility — 503 vs 404 on a product page
// ════════════════════════════════════════════════════════════════════════════
describe("storefront_accessibility separates unreachable from unpublished", () => {
  const url = (n: number) => `https://s.com/products/p${n}`;

  it("a transient 503 on one page degrades — the normae-shop.com case", async () => {
    const r = await checkStorefrontAccessibility(
      "https://s.com",
      [
        { url: url(1), status: 200, html: "<html></html>" },
        { url: url(2), status: 503, html: "" },
        { url: url(3), status: 200, html: "<html></html>" },
      ],
      200,
      "<html></html>",
    );
    expect(r.passed).toBe(true);
    expect(r.severity).toBe("info");
    expect(r.scorable).toBe(false);
    expect(r.title).toMatch(/Not Checked$/);
    expect((r.raw_data as Record<string, unknown>).degraded_reason).toBe(
      "product_page_fetch_unavailable",
    );
  });

  it("a 404 is still reported as a real warning", async () => {
    const r = await checkStorefrontAccessibility(
      "https://s.com",
      [
        { url: url(1), status: 200, html: "<html></html>" },
        { url: url(2), status: 404, html: "" },
      ],
      200,
      "<html></html>",
    );
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("warning");
    expect(r.title).toMatch(/Aren't Loading/);
  });

  it("a definitive 404 wins over a co-occurring 503", async () => {
    const r = await checkStorefrontAccessibility(
      "https://s.com",
      [
        { url: url(1), status: 404, html: "" },
        { url: url(2), status: 503, html: "" },
      ],
      200,
      "<html></html>",
    );
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("warning");
  });

  it("a timeout (status null) degrades rather than accusing", async () => {
    const r = await checkStorefrontAccessibility(
      "https://s.com",
      [{ url: url(1), status: null, html: null }],
      200,
      "<html></html>",
    );
    expect(r.passed).toBe(true);
    expect(r.scorable).toBe(false);
  });

  it("stops claiming 'publicly accessible (HTTP unknown)' when the homepage never loaded", async () => {
    const r = await checkStorefrontAccessibility("https://s.com", [], null, null);
    expect(r.scorable).toBe(false);
    expect(r.description).not.toMatch(/HTTP unknown/);
    expect(r.title).toMatch(/Not Checked$/);
    expect((r.raw_data as Record<string, unknown>).degraded_reason).toBe(
      "homepage_fetch_unavailable",
    );
  });

  it("all clear stays a normal pass", async () => {
    const r = await checkStorefrontAccessibility(
      "https://s.com",
      [{ url: url(1), status: 200, html: "<html></html>" }],
      200,
      "<html></html>",
    );
    expect(r.passed).toBe(true);
    expect(r.scorable).not.toBe(false);
    expect(r.description).toMatch(/publicly accessible \(HTTP 200\)/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2 + 3. getPages availability, and hidden_fee_detection in the second batch.
// Source-level, because the orchestrator harness lives in the Phase A suite and
// duplicating its ~90 lines of mocks here would be worse than asserting the wiring.
// ════════════════════════════════════════════════════════════════════════════
describe("getPages availability + hidden_fee_detection degradation are wired", () => {
  const orch = readSrc("app/lib/checks/index.server.ts");
  const api = readSrc("app/lib/shopify-api.server.ts");

  it("getPages has its own availability flag AND its own bounded retry", () => {
    expect(api).toMatch(/getPagesWithAvailability/);
    expect(api).toMatch(/pages: Page\[\]; available: boolean/);
    // The retry is what closes the divergence with getShopPolicies.
    expect(api).toMatch(/One bounded retry, mirroring getShopPolicies/);
    expect(api).toMatch(/return \{ pages: allPages, available: false \}/);
  });

  it("the orchestrator gates policy degradation on BOTH sources", () => {
    expect(orch).toMatch(
      /policiesUnavailable\s*=\s*!shopPolicies\.available\s*\|\|\s*!pagesResult\.available/,
    );
  });

  it("hidden_fee_detection is degraded despite living in the second batch", () => {
    expect(orch).toMatch(/check11Degraded/);
    expect(orch).toMatch(/hidden_fee_detection/);
    // And the degraded copy — not the raw one — is what gets persisted.
    const listIdx = orch.indexOf("const checkResults: CheckResult[]");
    expect(orch.slice(listIdx, listIdx + 260)).toMatch(/check11Degraded/);
    expect(orch.slice(listIdx, listIdx + 260)).not.toMatch(/\bcheck11,/);
  });

  it("the public scanner returns the DEGRADED array, not the raw tuple", () => {
    const ps = readSrc("app/lib/checks/public-scanner.server.ts");
    expect(ps).toMatch(/results: finalResults/);
    // Guard the exact bug introduced-and-caught while writing this: returning
    // `results` here made the whole degradation cosmetic.
    expect(ps).not.toMatch(/\n    results,\n/);
  });
});

// The CLI is a deliberate self-contained MIRROR (it must run standalone via
// node --experimental-strip-types, which cannot resolve the app's extensionless
// imports). CLAUDE.md's rule is to keep the two in sync — so guard that the same
// three-way classification exists there, since a drifted mirror is how the
// original triple-copy incident happened.
describe("CLI mirror carries the same classification", () => {
  const cli = readSrc("scripts/outbound-scanner.ts");

  it("classifies 404/410 as absent and everything else non-2xx as unavailable", () => {
    expect(cli).toMatch(/type FetchAvailability = "ok" \| "absent" \| "unavailable"/);
    expect(cli).toMatch(/r\.status === 404 \|\| r\.status === 410/);
    expect(cli).toMatch(/return "unavailable"/);
  });

  it("routes the policy fetches through the retrying variant", () => {
    expect(cli).toMatch(/fetchPageChecked\(`\$\{storeUrl\}\/policies\/shipping-policy`\)/);
    expect(cli).not.toMatch(/shippingFetch\?\.status === 200/);
  });

  it("degrades before printing, and prints the degraded array", () => {
    expect(cli).toMatch(/degradeUnverifiable/);
    expect(cli).toMatch(/printReport\(storeUrl, finalResults\)/);
    expect(cli).not.toMatch(/printReport\(storeUrl, results\)/);
  });
});

function readSrc(rel: string): string {
  return readFileSync(join(__dirname, "..", rel), "utf8");
}
