/**
 * Behavioral regression tests for the 2026-07 scan reliability fixes
 * (docs/scan-reliability-audit.md). These exercise the REAL check modules to
 * lock in the false-positive fixes: every check is biased toward false
 * negatives, so benign/reassuring storefront copy must never be flagged.
 */

import { describe, it, expect } from "vitest";
import { checkHiddenFeeDetection } from "../app/lib/checks/hidden-fee-detection.server";

// A storeUrl whose host cannot resolve, so the /cart fetch fails safely (null)
// and no real network egress happens during the test.
const NO_CART_STORE = "https://shieldkit-test.invalid";

function productPage(html: string) {
  return [
    { url: "https://shieldkit-test.invalid/products/x", status: 200, html: `<html><body>${html}</body></html>` },
  ];
}

function policies(shipping = "", refund = "") {
  return {
    REFUND_POLICY: refund ? { body: refund, url: "" } : null,
    SHIPPING_POLICY: shipping ? { body: shipping, url: "" } : null,
    PRIVACY_POLICY: null,
    TERMS_OF_SERVICE: null,
  } as never;
}

describe("hidden_fee_detection — negation & positive-charge handling", () => {
  it('passes on reassurance copy "no restocking fee"', async () => {
    const r = await checkHiddenFeeDetection(
      NO_CART_STORE,
      { html: null },
      productPage("<p>Easy returns. We charge <strong>no restocking fee</strong>, ever.</p>"),
      policies(),
    );
    expect(r.passed).toBe(true);
    expect(r.severity).toBe("info");
  });

  it('passes on "never a handling fee"', async () => {
    const r = await checkHiddenFeeDetection(
      NO_CART_STORE,
      { html: null },
      productPage("<p>There is never a handling fee on your order.</p>"),
      policies(),
    );
    expect(r.passed).toBe(true);
    expect(r.severity).toBe("info");
  });

  it('passes on "free shipping, no hidden fees"', async () => {
    const r = await checkHiddenFeeDetection(
      NO_CART_STORE,
      { html: null },
      productPage("<p>Free shipping, no hidden fees.</p>"),
      policies(),
    );
    expect(r.passed).toBe(true);
  });

  it('passes on "zero additional costs"', async () => {
    const r = await checkHiddenFeeDetection(
      NO_CART_STORE,
      { html: null },
      productPage("<p>What you see is what you pay — zero additional costs.</p>"),
      policies(),
    );
    expect(r.passed).toBe(true);
  });

  it('flags CRITICAL on a positively-charged, undisclosed "restocking fee of 20% applies"', async () => {
    const r = await checkHiddenFeeDetection(
      NO_CART_STORE,
      { html: null },
      productPage("<p>A restocking fee of 20% applies to all returns.</p>"),
      policies(),
    );
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("critical");
    expect((r.raw_data as { undisclosed_terms: string[] }).undisclosed_terms).toContain("restocking fee");
  });

  it("passes when the same charged fee is disclosed in the refund policy", async () => {
    const r = await checkHiddenFeeDetection(
      NO_CART_STORE,
      { html: null },
      productPage("<p>A restocking fee of 20% applies to all returns.</p>"),
      policies("", "Returns are subject to a restocking fee of 20% as described here."),
    );
    expect(r.passed).toBe(true);
    expect(r.severity).toBe("info");
  });

  it('drops ambiguous mentions with no positive-charge signal (e.g. bare "surcharge")', async () => {
    const r = await checkHiddenFeeDetection(
      NO_CART_STORE,
      { html: null },
      productPage("<p>Learn more about our surcharge policy in the FAQ.</p>"),
      policies(),
    );
    expect(r.passed).toBe(true);
  });
});
