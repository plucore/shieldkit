/**
 * Behavioral regression tests for the public /scan scanner after porting the
 * 2026-07 false-positive fixes (docs/scan-reliability-audit.md). HTML-only —
 * these scanners have no Shopify Admin API. Bias is toward false negatives:
 * reassuring/benign/JS-rendered content must not be flagged.
 */

import { describe, it, expect } from "vitest";
import {
  checkContactInformation,
  checkCheckoutTransparency,
  checkStructuredDataJsonLd,
} from "../app/lib/checks/public-scanner.server";

function ldProductPage(schema: unknown) {
  const html = `<html><head><script type="application/ld+json">${JSON.stringify(schema)}</script></head><body>ok</body></html>`;
  return [{ url: "https://x.example/products/p", status: 200, html }];
}
const PRODUCT_BASE = {
  "@context": "https://schema.org/",
  "@type": "Product",
  name: "Cast Iron Skillet",
  image: ["https://cdn.shopify.com/x.jpg"],
  description: "A durable skillet.",
};

describe("public checkout_transparency — INFO best-practice + broadened detection", () => {
  it("detects tentree-style inline SVG <title>Visa</title> markup", () => {
    const html =
      '<html><body><footer><svg class="w-12" role="img" aria-labelledby="pi-visa">' +
      '<title id="pi-visa">Visa</title></svg></footer></body></html>';
    const r = checkCheckoutTransparency("https://x.example", html);
    expect(r.passed).toBe(true);
    expect(r.severity).toBe("info");
  });

  it("detects data-enabled-payment-types markup", () => {
    const html =
      "<html><body><div data-enabled-payment-types='[&quot;apple_pay&quot;]'></div></body></html>";
    const r = checkCheckoutTransparency("https://x.example", html);
    expect(r.passed).toBe(true);
    expect(r.severity).toBe("info");
  });

  it("stays INFO with no 'required'/'suspension' language when no signal is present", () => {
    const r = checkCheckoutTransparency("https://x.example", "<html><body><p>Hi</p></body></html>");
    expect(r.severity).toBe("info");
    expect(r.passed).toBe(true);
    expect(r.description.toLowerCase()).not.toContain("required to");
    expect(r.description).not.toMatch(/suspen/i);
    expect(r.fix_instruction).toContain("Settings → Payments");
  });
});

describe("public contact_information — 1-of-N, WARNING not CRITICAL", () => {
  it("passes with only an email in the about page", () => {
    const r = checkContactInformation(null, "<p>Email hello@store.com</p>", null);
    expect(r.passed).toBe(true);
    expect(r.severity).toBe("info");
  });

  it("passes with only a mailto in the homepage footer (contact/about pages 404)", () => {
    const r = checkContactInformation(null, null, '<footer><a href="mailto:help@store.com">Email</a></footer>');
    expect(r.passed).toBe(true);
  });

  it("passes with only social profile links in the homepage footer", () => {
    const r = checkContactInformation(null, null, '<footer><a href="https://instagram.com/store">IG</a></footer>');
    expect(r.passed).toBe(true);
  });

  it("passes with only a contact page/form link", () => {
    const r = checkContactInformation(null, null, '<nav><a href="/pages/contact">Contact</a></nav>');
    expect(r.passed).toBe(true);
  });

  it("warns (not critical) only when zero contact of any kind is found", () => {
    const r = checkContactInformation(null, null, "<main><p>Welcome</p></main>");
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("warning");
    expect(r.severity).not.toBe("critical");
  });
});

describe("public structured_data_json_ld — offers shapes + INFO when absent", () => {
  it("passes on an offers ARRAY of valid Offers", () => {
    const r = checkStructuredDataJsonLd(
      ldProductPage({
        ...PRODUCT_BASE,
        offers: [
          { "@type": "Offer", price: "59.00", priceCurrency: "USD" },
          { "@type": "Offer", price: "69.00", priceCurrency: "USD" },
        ],
      }),
    );
    expect(r.passed).toBe(true);
    expect(r.severity).toBe("info");
  });

  it("passes on an AggregateOffer (lowPrice/highPrice/priceCurrency)", () => {
    const r = checkStructuredDataJsonLd(
      ldProductPage({
        ...PRODUCT_BASE,
        offers: { "@type": "AggregateOffer", lowPrice: "59.00", highPrice: "69.00", priceCurrency: "USD" },
      }),
    );
    expect(r.passed).toBe(true);
    expect(r.severity).toBe("info");
  });

  it("warns when a Product schema is present but has no price", () => {
    const r = checkStructuredDataJsonLd(
      ldProductPage({ ...PRODUCT_BASE, offers: { "@type": "Offer", priceCurrency: "USD" } }),
    );
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("warning");
  });

  it("returns INFO (not warning) when no JSON-LD is present in the static HTML", () => {
    const r = checkStructuredDataJsonLd([
      { url: "https://x.example/products/p", status: 200, html: "<html><body>no schema</body></html>" },
    ]);
    expect(r.passed).toBe(true);
    expect(r.severity).toBe("info");
    expect(r.severity).not.toBe("warning");
  });
});
