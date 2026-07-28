/**
 * tests/trust-defects.test.ts
 *
 * Guards for the two false-positive classes found in the 2026-07-28 churn
 * post-mortem. Both caused paying merchants to be shown compliance failures
 * that were not real, and both are the kind of defect that erodes trust in the
 * criticals that ARE right.
 *
 * CLASS 1 (intermittent) — a failed Shopify Admin API policy fetch was
 * indistinguishable from "this shop has no policies", so four checks reported
 * CRITICAL at once. `critical_count = 4` was the only bucket in the scans table
 * that co-occurred with `shop_info_unavailable` (9 of 17; 0 of 98 elsewhere).
 *
 * CLASS 2 (persistent) — `@type: ProductGroup`, which is what Shopify emits for
 * any product with variants, was not recognised as a product at all, and its
 * required fields live split across the group and its `hasVariant` entries.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  findProductSchema,
  missingRequiredProductFields,
} from "../app/lib/checks/shared/html-detectors.server";

const root = join(__dirname, "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");

// ─── CLASS 2: ProductGroup (behavioural — the real detector) ─────────────────

// Shape verified against izzyplants.com/products/winter-plant-shipping-protection
// on 2026-07-28: group has name/description/brand, variants have image/offers.
const PRODUCT_GROUP_HTML = `<html><head>
<script type="application/ld+json">
{"@context":"http://schema.org/","@type":"ProductGroup",
 "name":"Winter Plant Shipping Protection",
 "description":"Tropical plants and cold weather don't mix.",
 "brand":{"@type":"Brand","name":"House Plant Dropship"},
 "productGroupID":"123",
 "hasVariant":[
   {"@type":"Product","name":"1-2 Plants","sku":"A1","gtin":"00001",
    "image":"https://cdn.example/img.png",
    "offers":{"@type":"Offer","price":"4.99","priceCurrency":"USD",
              "availability":"http://schema.org/InStock"}},
   {"@type":"Product","name":"3-4 Plants","sku":"A2",
    "image":"https://cdn.example/img2.png",
    "offers":{"@type":"Offer","price":"8.99","priceCurrency":"USD"}}
 ]}
</script></head><body></body></html>`;

describe("structured data: ProductGroup is a product", () => {
  it("findProductSchema recognises @type ProductGroup", () => {
    const { productSchema, sawAnyJsonLd } = findProductSchema(PRODUCT_GROUP_HTML);
    expect(sawAnyJsonLd).toBe(true);
    // Pre-fix this returned null, producing "No Product JSON-LD schema found"
    // on every Shopify store whose products have variants.
    expect(productSchema).not.toBeNull();
    expect(productSchema!["@type"]).toBe("ProductGroup");
  });

  it("required fields are satisfied across the group AND its variants", () => {
    const { productSchema } = findProductSchema(PRODUCT_GROUP_HTML);
    // name + description live on the group; image + offers live on the variants.
    // Validating only the top level reported image and offers as missing.
    expect(missingRequiredProductFields(productSchema!)).toEqual([]);
  });

  it("still reports genuinely absent fields on a ProductGroup", () => {
    const bare = {
      "@type": "ProductGroup",
      name: "X",
      hasVariant: [{ "@type": "Product", name: "X-1" }],
    };
    const missing = missingRequiredProductFields(bare);
    expect(missing).toContain("image");
    expect(missing).toContain("description");
    expect(missing).toContain("offers");
  });

  it("a plain Product is unaffected", () => {
    const html = `<script type="application/ld+json">
      {"@type":"Product","name":"N","image":"i","description":"d",
       "offers":{"@type":"Offer","price":"1.00","priceCurrency":"USD"}}
    </script>`;
    const { productSchema } = findProductSchema(html);
    expect(productSchema).not.toBeNull();
    expect(missingRequiredProductFields(productSchema!)).toEqual([]);
  });
});

// ─── CLASS 1: never report a failure you could not verify ───────────────────

describe("Admin API unavailability must degrade, not fabricate failures", () => {
  const api = read("app", "lib", "shopify-api.server.ts");
  const queries = read("app", "lib", "graphql-queries.server.ts");
  const orch = read("app", "lib", "checks", "index.server.ts");

  it("ShopPoliciesResult carries an `available` flag", () => {
    expect(queries).toMatch(/available:\s*boolean/);
  });

  it("getShopPolicies returns available:false when it has no answer", () => {
    expect(api).toMatch(/available:\s*false/);
    expect(api).toMatch(/available:\s*true/);
    // A GraphQL error with no data must no longer fall through to an empty
    // (= "no policies") result — it must retry, then report unavailable.
    expect(api).toMatch(/getShopPolicies:retry/);
    expect(api).toMatch(/return unavailable/);
  });

  it("the retry happens BEFORE any result is returned as authoritative", () => {
    const retryIdx = api.indexOf("getShopPolicies:retry");
    const trueIdx = api.indexOf("available: true");
    expect(retryIdx).toBeGreaterThan(-1);
    expect(retryIdx).toBeLessThan(trueIdx);
  });

  it("the orchestrator degrades the policy checks to NON-SCORABLE info", () => {
    expect(orch).toMatch(/shopPolicies\.available/);
    expect(orch).toMatch(/degradeUnverifiable/);
    // Non-scorable = excluded from BOTH sides of the score, as page_speed is.
    expect(orch).toMatch(/scorable:\s*false/);
    // And it must not present as a failure.
    expect(orch).toMatch(/passed:\s*true/);
  });

  it("all three policy checks plus contact are covered", () => {
    for (const c of [
      "refund_return_policy",
      "shipping_policy",
      "privacy_and_terms",
      "contact_information",
    ]) {
      expect(orch, `${c} not degraded on unavailable data`).toContain(c);
    }
    const degradeIdx = orch.indexOf("degradeUnverifiable");
    expect(orch.slice(degradeIdx).includes("refund_return_policy")).toBe(true);
  });

  it("emits a scan-level DEGRADED marker so a partial scan is visible", () => {
    expect(orch).toMatch(/scan_data_availability/);
    expect(orch).toMatch(/Partial Scan/);
    expect(orch).toMatch(/skipped_checks/);
  });

  it("alarms on an implausible score collapse between consecutive scans", () => {
    expect(orch).toMatch(/IMPLAUSIBLE SCORE COLLAPSE/);
    // >20 point drop OR 0 -> 4+ criticals, the exact fabricated-criticals shape.
    expect(orch).toMatch(/scoreDrop\s*>\s*20/);
    expect(orch).toMatch(/prevCrit === 0 && criticalCount >= 4/);
  });

  it("the collapse check can never fail the scan", () => {
    const idx = orch.indexOf("score-collapse");
    expect(idx).toBeGreaterThan(-1);
    // Wrapped in try/catch with a non-fatal log.
    expect(orch).toMatch(/score-collapse check failed \(non-fatal\)/);
  });
});
