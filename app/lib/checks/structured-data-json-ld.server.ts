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

import { load as cheerioLoad } from "cheerio";
import type { CheckResult, PageFetchResult, PageReport } from "./types";

const RECOMMENDED_FIELDS = ["sku", "itemCondition", "gtin", "mpn"] as const;

/** Normalises the `offers` value to an array of offer objects. */
function normalizeOffers(offers: unknown): Record<string, unknown>[] {
  if (Array.isArray(offers)) {
    return offers.filter(
      (o): o is Record<string, unknown> => !!o && typeof o === "object" && !Array.isArray(o),
    );
  }
  if (offers && typeof offers === "object") {
    return [offers as Record<string, unknown>];
  }
  return [];
}

/** True if an offer node carries a usable price (Offer.price or AggregateOffer.low/highPrice). */
function offerHasPrice(o: Record<string, unknown>): boolean {
  const present = (v: unknown) => v !== undefined && v !== null && v !== "";
  return (
    present(o["price"]) ||
    present(o["lowPrice"]) ||
    present(o["highPrice"]) ||
    (!!o["priceSpecification"] && typeof o["priceSpecification"] === "object")
  );
}

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

    const $ = cheerioLoad(page.html);
    let productSchema: Record<string, unknown> | null = null;
    let sawAnyJsonLd = false;

    $('script[type="application/ld+json"]').each((_, el) => {
      sawAnyJsonLd = true;
      if (productSchema) return;
      try {
        const raw = JSON.parse($(el).html() ?? "{}") as Record<string, unknown>;
        const candidates: unknown[] = Array.isArray(raw)
          ? raw
          : Array.isArray(raw["@graph"])
          ? (raw["@graph"] as unknown[])
          : [raw];

        for (const node of candidates) {
          if (node && typeof node === "object" && !Array.isArray(node)) {
            const t = (node as Record<string, unknown>)["@type"];
            const isProduct =
              t === "Product" || (Array.isArray(t) && t.includes("Product"));
            if (isProduct) {
              productSchema = node as Record<string, unknown>;
              break;
            }
          }
        }
      } catch {
        // Malformed JSON-LD block — ignore; other blocks may still parse.
      }
    });

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

    // Product schema IS present — validate required fields.
    const missingRequired: string[] = [];
    for (const field of ["name", "image", "description"] as const) {
      if (!productSchema[field]) missingRequired.push(field);
    }

    const offers = productSchema["offers"];
    if (!offers) {
      missingRequired.push("offers");
    } else {
      const offerObjs = normalizeOffers(offers);
      if (offerObjs.length === 0) {
        missingRequired.push("offers");
      } else {
        // Accept if ANY offer conveys the field (arrays hold one Offer/variant).
        if (!offerObjs.some(offerHasPrice)) missingRequired.push("offers.price");
        if (!offerObjs.some((o) => !!o["priceCurrency"]))
          missingRequired.push("offers.priceCurrency");
      }
    }

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
