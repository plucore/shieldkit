/**
 * CHECK 11 — hidden_fee_detection
 *
 * Detects hidden surcharges (handling, restocking, processing, convenience,
 * service, surcharge) that appear on product or cart pages without being
 * disclosed in the merchant's shipping/refund policies. Direct GMC
 * misrepresentation trigger under Google's July 2025 zero-tolerance rule.
 *
 * Inputs:
 *  - shopPolicies: refund + shipping policy bodies (already fetched)
 *  - homepageHtml: the homepage HTML (already pre-fetched by orchestrator)
 *  - productPages: pre-fetched product pages
 *  - cartHtml: cart page HTML (fetched here — homepage's host + /cart)
 *
 * The orchestrator passes shopPolicies, homepage HTML, productPageResults.
 * It does NOT currently pre-fetch /cart, so this check fetches it via
 * fetchPublicPage at run time.
 */

import { load as cheerioLoad } from "cheerio";
import type { ShopPoliciesResult } from "../shopify-api.server";
import type { CheckResult, PageFetchResult } from "./types";
import { stripHtml, fetchPublicPage } from "./helpers.server";

const FEE_TERMS = [
  "handling fee",
  "restocking fee",
  "processing fee",
  "convenience fee",
  "service charge",
  "surcharge",
];

function visibleText(html: string | null | undefined): string {
  if (!html) return "";
  const $ = cheerioLoad(html);
  // Strip script/style first.
  $("script, style, noscript").remove();
  return stripHtml($("body").length ? $("body").html() ?? "" : html);
}

interface MatchHit {
  term: string;
  source: string; // "product:<url>", "cart", "homepage"
}

function findMatches(text: string, source: string): MatchHit[] {
  const lower = text.toLowerCase();
  const hits: MatchHit[] = [];
  for (const term of FEE_TERMS) {
    if (lower.includes(term)) hits.push({ term, source });
  }
  return hits;
}

export async function checkHiddenFeeDetection(
  storeUrl: string,
  homepageFetch: { html: string | null } | null,
  productPages: PageFetchResult[],
  shopPolicies: ShopPoliciesResult,
): Promise<CheckResult> {
  const CHECK_NAME = "hidden_fee_detection";

  // Build the combined storefront-side text.
  const productHits: MatchHit[] = [];
  for (const page of productPages.slice(0, 5)) {
    const txt = visibleText(page.html);
    productHits.push(...findMatches(txt, `product:${page.url}`));
  }

  // Cart page lives at /cart on every Shopify storefront.
  const cartUrl = (() => {
    try {
      const u = new URL(storeUrl);
      return `${u.protocol}//${u.host}/cart`;
    } catch {
      return null;
    }
  })();

  let cartHits: MatchHit[] = [];
  if (cartUrl) {
    const cartFetch = await fetchPublicPage(cartUrl, 8_000);
    if (cartFetch?.html) {
      cartHits = findMatches(visibleText(cartFetch.html), "cart");
    }
  }

  // Homepage is opportunistic — we already have it pre-fetched.
  const homepageHits: MatchHit[] = homepageFetch?.html
    ? findMatches(visibleText(homepageFetch.html), "homepage")
    : [];

  const storefrontHits = [...productHits, ...cartHits, ...homepageHits];

  // Now check whether each detected fee term is also disclosed in policies.
  const policyText = [
    visibleText(shopPolicies.SHIPPING_POLICY?.body ?? ""),
    visibleText(shopPolicies.REFUND_POLICY?.body ?? ""),
  ]
    .join(" ")
    .toLowerCase();

  const undisclosedTerms = new Set<string>();
  for (const hit of storefrontHits) {
    if (!policyText.includes(hit.term)) {
      undisclosedTerms.add(hit.term);
    }
  }

  // No fees found anywhere → pass.
  if (storefrontHits.length === 0) {
    return {
      check_name: CHECK_NAME,
      passed: true,
      severity: "info",
      title: "Hidden Fee Detection",
      description: "No surcharge or extra-fee language detected on storefront pages.",
      fix_instruction: "No action required.",
      raw_data: { fees_detected: [] },
    };
  }

  // Fees mentioned, but each one is also disclosed in policies → pass.
  if (undisclosedTerms.size === 0) {
    return {
      check_name: CHECK_NAME,
      passed: true,
      severity: "info",
      title: "Hidden Fee Detection",
      description: `${storefrontHits.length} fee mention${storefrontHits.length === 1 ? "" : "s"} found on storefront pages — all disclosed in your shipping/refund policy.`,
      fix_instruction: "No action required.",
      raw_data: {
        fees_detected: storefrontHits,
        all_disclosed: true,
      },
    };
  }

  // Fees on storefront but NOT in policy → fail (high severity).
  const undisclosedList = Array.from(undisclosedTerms);
  const hitsByTerm = new Map<string, string[]>();
  for (const hit of storefrontHits) {
    if (!undisclosedTerms.has(hit.term)) continue;
    if (!hitsByTerm.has(hit.term)) hitsByTerm.set(hit.term, []);
    hitsByTerm.get(hit.term)!.push(hit.source);
  }

  const description =
    `Found ${undisclosedList.length} undisclosed fee term${undisclosedList.length === 1 ? "" : "s"} on your storefront (${undisclosedList.join(", ")}) ` +
    `that are not mentioned in your shipping or refund policy. Google Merchant Center treats undisclosed fees as misrepresentation.`;

  return {
    check_name: CHECK_NAME,
    passed: false,
    severity: "critical",
    title: "Undisclosed Fees Detected",
    description,
    fix_instruction:
      "1. In Shopify Admin → Settings → Policies, edit your Shipping Policy " +
      "(and/or Refund Policy) to clearly explain every fee charged at checkout: " +
      `${undisclosedList.join(", ")}.\n` +
      "2. State who pays the fee, when, and the typical amount or formula.\n" +
      "3. After saving, re-run the scan to confirm.",
    raw_data: {
      fees_detected: storefrontHits,
      undisclosed_terms: undisclosedList,
      hits_by_term: Object.fromEntries(hitsByTerm),
    },
  };
}
