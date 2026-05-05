/**
 * CHECK 8 — structured_data_json_ld
 *
 * Validates Product JSON-LD structured data on up to 3 product pages.
 * Required fields: name, image, description, offers (price, priceCurrency, availability).
 * Recommended fields: sku, itemCondition.
 */

import { load as cheerioLoad } from "cheerio";
import type { CheckResult, PageFetchResult, PageReport } from "./types";

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

  const REQUIRED_FIELDS = ["name", "image", "description", "offers"] as const;
  const OFFER_REQUIRED = ["price", "priceCurrency", "availability"] as const;
  // Phase 5 enriched recommended fields. brand is recommended but always
  // emitted by the theme block (falls back to shop.name) so we don't list
  // it here. gtin/mpn appear only after the GTIN Auto-Filler runs;
  // identifier_exists=false is a valid alternative when the product has
  // no real identifier (handmade, vintage). MerchantReturnPolicy and
  // OfferShippingDetails are reported as recommended but aren't penalised
  // when missing — Google treats them as bonus.
  const RECOMMENDED_FIELDS = ["sku", "itemCondition", "gtin", "mpn"] as const;

  const reports: PageReport[] = [];
  let totalMissingRequired = 0;

  for (const page of productPageResults) {
    if (!page.html) {
      reports.push({
        url: page.url,
        product_schema_found: false,
        missing_required: ["page_fetch_failed"],
        missing_recommended: [],
      });
      totalMissingRequired++;
      continue;
    }

    const $ = cheerioLoad(page.html);
    let productSchema: Record<string, unknown> | null = null;

    // Scan all <script type="application/ld+json"> blocks
    $('script[type="application/ld+json"]').each((_, el) => {
      if (productSchema) return;
      try {
        const raw = JSON.parse($(el).html() ?? "{}") as Record<string, unknown>;
        // Handle a single object, an array, or a @graph array
        const candidates: unknown[] = Array.isArray(raw)
          ? raw
          : Array.isArray(raw["@graph"])
          ? (raw["@graph"] as unknown[])
          : [raw];

        for (const node of candidates) {
          if (
            node &&
            typeof node === "object" &&
            !Array.isArray(node) &&
            (node as Record<string, unknown>)["@type"] === "Product"
          ) {
            productSchema = node as Record<string, unknown>;
            break;
          }
        }
      } catch {
        // Malformed JSON-LD — count as missing schema
      }
    });

    if (!productSchema) {
      reports.push({
        url: page.url,
        product_schema_found: false,
        missing_required: [...REQUIRED_FIELDS],
        missing_recommended: [...RECOMMENDED_FIELDS],
      });
      totalMissingRequired += REQUIRED_FIELDS.length;
      continue;
    }

    const missingRequired: string[] = [];
    for (const field of REQUIRED_FIELDS) {
      if (!productSchema[field]) missingRequired.push(field);
    }

    // Validate the nested offers object
    const offers = productSchema["offers"] as Record<string, unknown> | undefined;
    if (offers) {
      for (const field of OFFER_REQUIRED) {
        if (!offers[field]) missingRequired.push(`offers.${field}`);
      }
    }

    const missingRecommended: string[] = [];
    for (const field of RECOMMENDED_FIELDS) {
      if (!productSchema[field]) missingRecommended.push(field);
    }
    // Phase 5: identifier_exists=false is a valid alternative to gtin/mpn
    // for handmade/vintage products. When present and false, suppress the
    // gtin/mpn missing flags so we don't double-fault legitimate cases.
    if (productSchema["identifier_exists"] === false) {
      const idx1 = missingRecommended.indexOf("gtin");
      if (idx1 >= 0) missingRecommended.splice(idx1, 1);
      const idx2 = missingRecommended.indexOf("mpn");
      if (idx2 >= 0) missingRecommended.splice(idx2, 1);
    }

    totalMissingRequired += missingRequired.length;
    reports.push({
      url: page.url,
      product_schema_found: true,
      missing_required: missingRequired,
      missing_recommended: missingRecommended,
    });
  }

  const pagesWithNoSchema = reports.filter((r) => !r.product_schema_found).length;
  const raw_data = {
    pages_scanned: productPageResults.length,
    pages_with_product_schema: reports.filter((r) => r.product_schema_found).length,
    pages_without_schema: pagesWithNoSchema,
    page_reports: reports,
  };

  if (totalMissingRequired === 0) {
    return {
      check_name: CHECK_NAME,
      passed: true,
      severity: "info",
      title: "Structured Data (JSON-LD)",
      description: `Product JSON-LD schema found and validated on all ${productPageResults.length} sampled product page(s).`,
      fix_instruction: "No action required.",
      raw_data,
    };
  }

  const allMissing = [...new Set(reports.flatMap((r) => r.missing_required))];

  return {
    check_name: CHECK_NAME,
    passed: false,
    severity: "warning",
    title: "Incomplete or Missing Product JSON-LD Schema",
    description:
      pagesWithNoSchema === productPageResults.length
        ? `No Product JSON-LD schema found on any of the ${productPageResults.length} sampled product page(s). ` +
          "Google uses structured data to understand and display products in Shopping results."
        : `Product JSON-LD schema is missing required fields on ` +
          `${reports.filter((r) => r.missing_required.length > 0).length} of ` +
          `${productPageResults.length} scanned page(s). Missing: ${allMissing.join(", ")}.`,
    fix_instruction:
      "1. Shopify's default themes inject Product JSON-LD automatically. If missing, " +
      "check that your theme's product.liquid template has not had structured data removed.\n" +
      "2. Required schema fields: name, image, description, and offers " +
      "(containing price, priceCurrency, availability).\n" +
      "3. Recommended additions: sku and itemCondition improve feed quality in GMC.\n" +
      "4. Validate with Google's Rich Results Test: https://search.google.com/test/rich-results",
    raw_data,
  };
}
