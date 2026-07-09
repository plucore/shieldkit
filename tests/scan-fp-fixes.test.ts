/**
 * Behavioral regression tests for the 2026-07 scan reliability fixes
 * (docs/scan-reliability-audit.md). These exercise the REAL check modules to
 * lock in the false-positive fixes: every check is biased toward false
 * negatives, so benign/reassuring storefront copy must never be flagged.
 */

import { describe, it, expect } from "vitest";
import { checkHiddenFeeDetection } from "../app/lib/checks/hidden-fee-detection.server";
import { checkContactInformation } from "../app/lib/checks/contact-information.server";
import { checkStructuredDataJsonLd } from "../app/lib/checks/structured-data-json-ld.server";
import { checkCheckoutTransparency } from "../app/lib/checks/checkout-transparency.server";
import { checkImageHostingAudit } from "../app/lib/checks/image-hosting-audit.server";
import type { ShopInfo, Page } from "../app/lib/shopify-api.server";
import type { Product } from "../app/lib/graphql-queries.server";

function mkProduct(descriptionHtml: string): Product {
  return {
    title: "Widget",
    description: "",
    descriptionHtml,
    handle: "widget",
    onlineStoreUrl: null,
    images: [],
    variants: [],
  };
}

function ldPage(schema: unknown) {
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

function mkShop(overrides: Partial<ShopInfo> = {}): ShopInfo {
  return {
    name: "Test Store",
    contactEmail: "",
    billingAddress: { address1: null, city: null, province: null, country: null, zip: null },
    myshopifyDomain: "test.myshopify.com",
    currencyCode: "USD",
    primaryDomain: { url: "https://teststore.com", host: "teststore.com" },
    shopOwnerName: null,
    ianaTimezone: null,
    createdAt: null,
    plan: { displayName: null, shopifyPlus: null, partnerDevelopment: null },
    ...overrides,
  };
}

function page(partial: Partial<Page>): Page {
  return { title: "", body: "", handle: "", url: null, ...partial };
}

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

describe("hidden_fee_detection — clause-scoped negation (P1-1 regression)", () => {
  // A negation attached to a DIFFERENT nearby fee (or benign copy) must NOT
  // suppress a genuine, positively-charged fee in its own clause/sentence.
  const MUST_FLAG: Array<[string, string]> = [
    ["negation on a different fee in the same sentence", "There is no handling fee, but a 15% restocking fee applies to returns."],
    ["chain of reassurance then a real fee", "No restocking fee, no handling fee — a 10% processing fee applies at checkout."],
    ["benign 'no questions asked' before a real fee", "Satisfaction guaranteed, no questions asked. A 20% restocking fee applies."],
    ["rhetorical 'Not sure?' before a real fee", "Not sure? A 20% restocking fee applies to opened items."],
    ["'without' negating a different noun", "Orders without free shipping incur a $5 handling fee."],
    ["same term negated then charged in a later clause", "No restocking fee on exchanges; a 20% restocking fee applies to refunds."],
    ["'deducted' verb with amount in the next sentence", "A restocking fee will be deducted from your refund for opened items. The amount is 20% of the item price."],
  ];

  for (const [label, copy] of MUST_FLAG) {
    it(`flags CRITICAL: ${label}`, async () => {
      const r = await checkHiddenFeeDetection(
        NO_CART_STORE,
        { html: null },
        productPage(`<p>${copy}</p>`),
        policies(),
      );
      expect(r.passed).toBe(false);
      expect(r.severity).toBe("critical");
    });
  }

  const MUST_PASS: Array<[string, string]> = [
    ["plain reassurance 'no restocking fee'", "Easy returns — we charge no restocking fee, ever."],
    ["'never a handling fee'", "There is never a handling fee on your order."],
    ["'free shipping, no hidden fees'", "Free shipping, no hidden fees on any order."],
    ["'we no longer charge a restocking fee'", "Good news: we no longer charge a restocking fee."],
  ];

  for (const [label, copy] of MUST_PASS) {
    it(`passes: ${label}`, async () => {
      const r = await checkHiddenFeeDetection(
        NO_CART_STORE,
        { html: null },
        productPage(`<p>${copy}</p>`),
        policies(),
      );
      expect(r.passed).toBe(true);
      expect(r.severity).toBe("info");
    });
  }

  it("still passes when the charged fee is disclosed in the provided policy text", async () => {
    const r = await checkHiddenFeeDetection(
      NO_CART_STORE,
      { html: null },
      productPage("<p>A 20% restocking fee applies to all returns.</p>"),
      policies("", "Returns incur a restocking fee of 20%, as described in this policy."),
    );
    expect(r.passed).toBe(true);
    expect(r.severity).toBe("info");
  });
});

describe("contact_information — 1-of-N, WARNING not CRITICAL", () => {
  it("passes with only an email in a page body", () => {
    const r = checkContactInformation(
      [page({ title: "FAQ", handle: "faq", body: "<p>Reach us at hello@teststore.com</p>" })],
      null,
    );
    expect(r.passed).toBe(true);
    expect(r.severity).toBe("info");
  });

  it("passes with only the Shopify store contact email (misen.com regression — no contact page)", () => {
    const r = checkContactInformation([], mkShop({ contactEmail: "support@teststore.com" }));
    expect(r.passed).toBe(true);
  });

  it("passes with only social profile links in the homepage footer", () => {
    const r = checkContactInformation(
      [],
      null,
      '<footer><a href="https://instagram.com/teststore">Instagram</a></footer>',
    );
    expect(r.passed).toBe(true);
  });

  it("passes with only a contact form/page link in the homepage markup", () => {
    const r = checkContactInformation(
      [],
      null,
      '<nav><a href="/pages/contact">Contact us</a></nav>',
    );
    expect(r.passed).toBe(true);
  });

  it("warns (not critical) only when zero contact of any kind is found", () => {
    const r = checkContactInformation([], null, "<main><p>Welcome to our store.</p></main>");
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("warning");
    expect(r.severity).not.toBe("critical");
  });

  it("does NOT pass on share/intent widget URLs alone (not the merchant's profile)", () => {
    const shareOnly =
      '<footer>' +
      '<a href="https://www.facebook.com/sharer/sharer.php?u=https://store.com">Share</a>' +
      '<a href="https://pinterest.com/pin/create/button/?url=x">Pin</a>' +
      '<a href="https://twitter.com/intent/tweet?url=x">Tweet</a>' +
      '<a href="https://www.facebook.com/share/p/abc/">Share</a>' +
      '</footer>';
    const r = checkContactInformation([], null, shareOnly);
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("warning");
    expect((r.raw_data as { social_found: boolean }).social_found).toBe(false);
  });

  it("still passes when a real social profile link is present alongside share widgets", () => {
    const mixed =
      '<footer>' +
      '<a href="https://www.facebook.com/sharer/sharer.php?u=x">Share</a>' +
      '<a href="https://www.facebook.com/mystore">Follow us</a>' +
      '</footer>';
    const r = checkContactInformation([], null, mixed);
    expect(r.passed).toBe(true);
    expect((r.raw_data as { social_found: boolean }).social_found).toBe(true);
  });
});

describe("structured_data_json_ld — offers shapes + INFO when absent", () => {
  it("passes on a Product whose offers is an ARRAY of valid Offers", async () => {
    const r = await checkStructuredDataJsonLd(
      ldPage({
        ...PRODUCT_BASE,
        offers: [
          { "@type": "Offer", price: "59.00", priceCurrency: "USD", availability: "https://schema.org/InStock" },
          { "@type": "Offer", price: "69.00", priceCurrency: "USD" },
        ],
      }),
    );
    expect(r.passed).toBe(true);
    expect(r.severity).toBe("info");
  });

  it("passes on a Product with an AggregateOffer (lowPrice/highPrice/priceCurrency)", async () => {
    const r = await checkStructuredDataJsonLd(
      ldPage({
        ...PRODUCT_BASE,
        offers: { "@type": "AggregateOffer", lowPrice: "59.00", highPrice: "69.00", priceCurrency: "USD" },
      }),
    );
    expect(r.passed).toBe(true);
    expect(r.severity).toBe("info");
  });

  it("passes when price AND priceCurrency are nested inside priceSpecification", async () => {
    const r = await checkStructuredDataJsonLd(
      ldPage({
        ...PRODUCT_BASE,
        offers: {
          "@type": "Offer",
          priceSpecification: {
            "@type": "UnitPriceSpecification",
            price: "10.00",
            priceCurrency: "USD",
          },
        },
      }),
    );
    expect(r.passed).toBe(true);
    expect(r.severity).toBe("info");
  });

  it("warns when a Product schema is present but has no price anywhere", async () => {
    const r = await checkStructuredDataJsonLd(
      ldPage({ ...PRODUCT_BASE, offers: { "@type": "Offer", priceCurrency: "USD" } }),
    );
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("warning");
    expect(r.description).toContain("offers.price");
  });

  it("returns INFO (not warning) when no JSON-LD is present in the static HTML", async () => {
    const r = await checkStructuredDataJsonLd([
      { url: "https://x.example/products/p", status: 200, html: "<html><body>no schema here</body></html>" },
    ]);
    expect(r.passed).toBe(true);
    expect(r.severity).toBe("info");
    expect(r.severity).not.toBe("warning");
  });
});

describe("checkout_transparency — INFO best-practice + broadened detection", () => {
  it("detects tentree-style inline SVG <title>Visa</title> markup", async () => {
    const html =
      '<html><body><footer><svg class="w-12 h-auto" role="img" aria-labelledby="pi-visa">' +
      '<title id="pi-visa">Visa</title></svg></footer></body></html>';
    const r = await checkCheckoutTransparency("https://x.example", html);
    expect(r.passed).toBe(true);
    expect(r.severity).toBe("info");
    expect((r.raw_data as { payment_icons_found: string[] }).payment_icons_found).toContain("visa");
  });

  it("detects data-enabled-payment-types markup", async () => {
    const html =
      "<html><body><div data-enabled-payment-types='[&quot;amazon_pay&quot;,&quot;apple_pay&quot;]'></div></body></html>";
    const r = await checkCheckoutTransparency("https://x.example", html);
    expect(r.passed).toBe(true);
    expect(r.severity).toBe("info");
  });

  it("never fails and stays INFO when no payment signal is present", async () => {
    const r = await checkCheckoutTransparency(
      "https://x.example",
      "<html><body><footer><p>© 2026 My Store</p></footer></body></html>",
    );
    expect(r.severity).toBe("info");
    expect(r.passed).toBe(true);
    expect(r.description.toLowerCase()).not.toContain("required");
  });

  it("uses INFO severity and no GMC-requirement language in the not-detected copy", async () => {
    const r = await checkCheckoutTransparency("https://x.example", "<html><body>nothing</body></html>");
    expect(r.severity).toBe("info");
    expect(r.description).not.toMatch(/suspen/i);
    expect(r.fix_instruction).toContain("Settings → Payments");
  });
});

describe("image_hosting_audit — WARNING advisory, no accusatory framing", () => {
  it("flags supplier-CDN images at WARNING (not CRITICAL) with no misrepresentation/dropshipper wording", () => {
    const r = checkImageHostingAudit([
      mkProduct('<p>Great item</p><img src="https://ae01.alicdn.com/kf/abc.jpg">'),
    ]);
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("warning");
    expect(r.severity).not.toBe("critical");
    const copy = `${r.title} ${r.description} ${r.fix_instruction}`.toLowerCase();
    expect(copy).not.toContain("misrepresentation");
    expect(copy).not.toContain("dropshipper");
    // Reframed around the real feed requirement.
    expect(copy).toContain("image_link");
  });

  it("passes cleanly when images are on a non-supplier CDN", () => {
    const r = checkImageHostingAudit([
      mkProduct('<img src="https://cdn.shopify.com/s/files/1/x.jpg">'),
    ]);
    expect(r.passed).toBe(true);
    expect(r.severity).toBe("info");
  });
});
