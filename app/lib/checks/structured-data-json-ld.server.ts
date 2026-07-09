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
      title: "Structured Data (JSON-LD)",
      description: "No product pages with public URLs were available to scan for structured data.",
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
    return {
      check_name: CHECK_NAME,
      passed: false,
      severity: "warning",
      title: "Incomplete Product JSON-LD Schema",
      description:
        `Product JSON-LD schema is present but missing required fields on ` +
        `${pagesIncomplete} of ${productPageResults.length} scanned product page(s). ` +
        `Missing: ${allMissing.join(", ")}. Google uses these fields to show your products in Shopping results.`,
      fix_instruction:
        "1. Shopify's default themes inject Product JSON-LD automatically. If a field is missing, " +
        "check that your theme's product template still outputs complete structured data.\n" +
        "2. Required fields: name, image, description, and offers with a price and priceCurrency " +
        "(offers may be a single object, an array of per-variant offers, or an AggregateOffer with lowPrice/highPrice).\n" +
        "3. Recommended additions: sku and itemCondition improve feed quality in GMC.\n" +
        "4. Validate with Google's Rich Results Test: https://search.google.com/test/rich-results",
      raw_data,
    };
  }

  // At least one page validated cleanly → PASS.
  if (pagesValid > 0) {
    return {
      check_name: CHECK_NAME,
      passed: true,
      severity: "info",
      title: "Structured Data (JSON-LD)",
      description: `Product JSON-LD schema found and validated on ${pagesValid} of ${productPageResults.length} sampled product page(s).`,
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
    title: "Structured Data (JSON-LD) — Not Verified",
    description:
      "No Product structured data was found in the initial HTML of the sampled product page(s). " +
      "Many Shopify themes inject JSON-LD via JavaScript, which an automated fetch cannot see, so " +
      "this is not necessarily a problem.",
    fix_instruction:
      "Confirm your products emit Product structured data using Google's Rich Results Test: " +
      "https://search.google.com/test/rich-results. If it passes there, no action is needed. " +
      "If not, ensure your theme's product template outputs Product JSON-LD (name, image, description, " +
      "and offers with price and priceCurrency).",
    raw_data,
  };
}
