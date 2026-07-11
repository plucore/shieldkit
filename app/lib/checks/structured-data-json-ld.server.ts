/**
 * CHECK 8 — structured_data_json_ld
 *
 * Validates Product JSON-LD structured data on up to 3 product pages.
 *
 * Required (for a WARNING when present-but-broken): name, image, description,
 * and offers with a price and priceCurrency. `offers` may be a single Offer, an
 * ARRAY of Offers (one per variant), or an AggregateOffer (lowPrice/highPrice) —
 * Google permits all three, so all three are accepted here.
 *
 * Detection is biased toward false negatives: a plain fetch cannot execute the
 * JavaScript that many themes use to inject JSON-LD, so when NO Product schema
 * is present in the static HTML we report INFO ("couldn't verify"), never a
 * confident "missing" WARNING. WARNING is reserved for a Product schema that IS
 * present in the HTML but genuinely missing required fields.
 */

import type { CheckResult, PageFetchResult, PageReport } from "./types";
import {
  findProductSchema,
  missingRequiredProductFields,
} from "./shared/html-detectors.server";

const RECOMMENDED_FIELDS = ["sku", "itemCondition", "gtin", "mpn"] as const;

export async function checkStructuredDataJsonLd(
  productPageResults: PageFetchResult[]
): Promise<CheckResult> {
  const CHECK_NAME = "structured_data_json_ld";

  if (productPageResults.length === 0) {
    return {
      check_name: CHECK_NAME,
      passed: true,
      severity: "info",
      title: "Google Product Listings",
      description: "No product pages with public web addresses were available to check.",
      fix_instruction: "No action required.",
      raw_data: { pages_scanned: 0 },
    };
  }

  const reports: PageReport[] = [];
  let pagesValid = 0;
  let pagesIncomplete = 0;
  let pagesAbsent = 0;

  for (const page of productPageResults) {
    // Could not fetch the page → cannot verify (not a "missing schema" fault).
    if (!page.html) {
      pagesAbsent++;
      reports.push({
        url: page.url,
        product_schema_found: false,
        missing_required: [],
        missing_recommended: [],
      });
      continue;
    }

    // Find the first Product JSON-LD node in the static HTML (shared detector).
    const { productSchema, sawAnyJsonLd } = findProductSchema(page.html);

    // No Product node in the static HTML — either no JSON-LD at all, or the
    // Product schema is injected client-side. Either way we cannot confidently
    // call it missing → treat as unverified (absent), not a failure.
    if (!productSchema) {
      pagesAbsent++;
      reports.push({
        url: page.url,
        product_schema_found: false,
        missing_required: sawAnyJsonLd ? ["no_product_node"] : ["no_json_ld"],
        missing_recommended: [],
      });
      continue;
    }

    // Product schema IS present — validate required fields (shared detector).
    const missingRequired = missingRequiredProductFields(productSchema);

    const missingRecommended: string[] = [];
    for (const field of RECOMMENDED_FIELDS) {
      if (!productSchema[field]) missingRecommended.push(field);
    }
    // identifier_exists=false is a valid alternative to gtin/mpn (handmade/vintage).
    if (productSchema["identifier_exists"] === false) {
      for (const f of ["gtin", "mpn"]) {
        const idx = missingRecommended.indexOf(f);
        if (idx >= 0) missingRecommended.splice(idx, 1);
      }
    }

    if (missingRequired.length === 0) {
      pagesValid++;
    } else {
      pagesIncomplete++;
    }
    reports.push({
      url: page.url,
      product_schema_found: true,
      missing_required: missingRequired,
      missing_recommended: missingRecommended,
    });
  }

  const raw_data = {
    pages_scanned: productPageResults.length,
    pages_valid: pagesValid,
    pages_incomplete: pagesIncomplete,
    pages_absent: pagesAbsent,
    page_reports: reports,
  };

  // A Product schema was present but malformed on ≥1 page → WARNING.
  if (pagesIncomplete > 0) {
    const allMissing = [
      ...new Set(
        reports
          .filter((r) => r.product_schema_found)
          .flatMap((r) => r.missing_required),
      ),
    ];
    // Map internal field tokens to plain-language labels a merchant can act on
    // (never surface raw tokens like "offers.priceCurrency" to the merchant).
    const FRIENDLY_FIELD: Record<string, string> = {
      name: "product name",
      image: "product photo",
      description: "description",
      offers: "price",
      "offers.price": "price",
      "offers.priceCurrency": "currency",
    };
    const friendlyMissing = [
      ...new Set(allMissing.map((f) => FRIENDLY_FIELD[f] ?? f)),
    ];
    return {
      check_name: CHECK_NAME,
      passed: false,
      severity: "warning",
      title: "Google Product Listings — Missing Details",
      description:
        `Your products show in Google but are missing some details Google ` +
        `needs (${friendlyMissing.join(", ")}). These help them show with ` +
        `full info in results.`,
      fix_instruction:
        "1. Most Shopify themes set this up automatically. If details are missing, your theme's " +
        "product template may have been changed.\n" +
        "2. Each product should list its name, photo, description, price, and currency.\n" +
        "3. Check your products free with Google's Rich Results Test: https://search.google.com/test/rich-results\n" +
        "4. If it keeps failing, your theme may need a developer to fix it.",
      raw_data,
    };
  }

  // At least one page validated cleanly → PASS.
  if (pagesValid > 0) {
    return {
      check_name: CHECK_NAME,
      passed: true,
      severity: "info",
      title: "Google Product Listings",
      description: `Your products are set up to show with full details in Google on ${pagesValid} of ${productPageResults.length} product page(s) we checked.`,
      fix_instruction: "No action required.",
      raw_data,
    };
  }

  // No Product schema found in any static HTML — likely injected client-side.
  // Report as unverified INFO rather than a confident "missing" warning.
  return {
    check_name: CHECK_NAME,
    passed: true,
    severity: "info",
    title: "Google Product Listings — Couldn't Verify",
    description:
      "We couldn't confirm your products are set up to show with prices and photos in Google. " +
      "Many themes do this in a way our scan can't see, so this may already be working.",
    fix_instruction:
      "Check your products free with Google's Rich Results Test: " +
      "https://search.google.com/test/rich-results. If it passes, you're all set. If not, make " +
      "sure your theme lists each product's name, image, description, price, and currency — or " +
      "ask your theme's developer.",
    raw_data,
  };
}
