/**
 * CHECK 11 — hidden_fee_detection
 *
 * Detects UNDISCLOSED, POSITIVELY-ASSERTED surcharges (handling, restocking,
 * processing, convenience, service, surcharge) on product/cart pages that are
 * not disclosed in the merchant's shipping/refund policies. Undisclosed
 * checkout fees are a genuine GMC misrepresentation trigger.
 *
 * Detection is deliberately biased toward false negatives so we never accuse a
 * merchant over benign copy:
 *  - A fee term wrapped in negation/reassurance ("no restocking fee", "we never
 *    charge a handling fee", "restocking fee waived") is NOT a fee.
 *  - A fee term is only counted when a POSITIVE charge is asserted nearby (a
 *    currency amount, a percentage, "applies", "we charge", "fee of", etc.).
 *  - Ambiguous mentions with neither negation nor a positive-charge signal are
 *    dropped rather than flagged.
 *  - A counted positive fee is only reported when the SAME term is not also
 *    mentioned in the shipping/refund policy text already fetched by the scan.
 *
 * Inputs:
 *  - shopPolicies: refund + shipping policy bodies (already fetched)
 *  - homepageFetch: the homepage HTML (already pre-fetched by orchestrator)
 *  - productPages: pre-fetched product pages
 *  - The cart page (/cart) is fetched here at run time.
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

// Number of characters scanned on each side of a fee term when deciding
// whether it is negated or a positive charge. Wide enough to catch the
// modifying clause; erring wide only ever suppresses (false-negative bias).
const CONTEXT_WINDOW = 45;

// Reassurance / negation copy near a fee term → treat as benign.
// Covers "no", "never", "zero", "without", "waived", "free of", and any
// "*n't" contraction (don't / doesn't / won't / isn't / aren't).
const NEGATION_RE =
  /\b(?:no|not|never|zero|without|waived?|free\s+of)\b|\b\w+n['’]t\b/i;

// A positive charge asserted near a fee term: a currency amount, a percentage,
// or an explicit "is charged / applies / fee of / we charge" phrasing.
const POSITIVE_CHARGE_RE =
  /\$\s?\d|\d+(?:\.\d+)?\s?%|\b\d+(?:\.\d+)?\s?(?:usd|eur|gbp|dollars?|cents?)\b|\bof\s+(?:\$?\d|up\s+to)|\bapplie[sd]\b|\bwill\s+be\s+(?:charged|added|applied)\b|\bwe\s+(?:charge|add|apply)\b|\bcharged?\s+(?:a|an|you|per|at|to)\b|\bfee\s+of\b|\bfee\s+is\b|\bplus\s+(?:a|an|\$?\d)\b|\bsubject\s+to\s+(?:a|an)\b|\bincur/i;

function visibleText(html: string | null | undefined): string {
  if (!html) return "";
  const $ = cheerioLoad(html);
  // Strip script/style first.
  $("script, style, noscript").remove();
  return stripHtml($("body").length ? $("body").html() ?? "" : html);
}

interface FeeHit {
  term: string;
  source: string; // "product:<url>", "cart", "homepage"
  context: string; // the surrounding text, for auditability
}

/**
 * Scans text for positively-asserted, non-negated fee mentions. Every
 * occurrence of each fee term is inspected within CONTEXT_WINDOW: negated
 * mentions are skipped, ambiguous mentions (no positive-charge signal) are
 * skipped, only clear positive charges are returned.
 */
function scanFees(text: string, source: string): FeeHit[] {
  const lower = text.toLowerCase();
  const hits: FeeHit[] = [];
  for (const term of FEE_TERMS) {
    let from = 0;
    let idx = lower.indexOf(term, from);
    while (idx !== -1) {
      from = idx + term.length;
      const start = Math.max(0, idx - CONTEXT_WINDOW);
      const end = idx + term.length + CONTEXT_WINDOW;
      const windowText = lower.slice(start, end);

      // Negated / reassurance copy → benign.
      // Positive charge required, else ambiguous → drop (false-negative bias).
      if (!NEGATION_RE.test(windowText) && POSITIVE_CHARGE_RE.test(windowText)) {
        hits.push({
          term,
          source,
          context: text.slice(start, end).replace(/\s+/g, " ").trim(),
        });
      }
      idx = lower.indexOf(term, from);
    }
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

  // Build the combined storefront-side hits (positive, non-negated only).
  const productHits: FeeHit[] = [];
  for (const page of productPages.slice(0, 5)) {
    const txt = visibleText(page.html);
    productHits.push(...scanFees(txt, `product:${page.url}`));
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

  let cartHits: FeeHit[] = [];
  if (cartUrl) {
    const cartFetch = await fetchPublicPage(cartUrl, 8_000);
    if (cartFetch?.html) {
      cartHits = scanFees(visibleText(cartFetch.html), "cart");
    }
  }

  // Homepage is opportunistic — we already have it pre-fetched.
  const homepageHits: FeeHit[] = homepageFetch?.html
    ? scanFees(visibleText(homepageFetch.html), "homepage")
    : [];

  const storefrontHits = [...productHits, ...cartHits, ...homepageHits];

  // Now check whether each positively-charged fee term is also disclosed in
  // the merchant's shipping/refund policy text.
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

  // No positively-asserted fees found anywhere → pass. (This covers stores
  // with reassurance copy like "no restocking fee" — those never become hits.)
  if (storefrontHits.length === 0) {
    return {
      check_name: CHECK_NAME,
      passed: true,
      severity: "info",
      title: "Hidden Fee Detection",
      description:
        "No undisclosed surcharge or extra-fee language detected on storefront pages.",
      fix_instruction: "No action required.",
      raw_data: { fees_detected: [] },
    };
  }

  // Fees charged, but each one is also disclosed in policies → pass.
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

  // Positive fees on storefront but NOT in policy → fail (critical).
  const undisclosedList = Array.from(undisclosedTerms);
  const hitsByTerm = new Map<string, string[]>();
  for (const hit of storefrontHits) {
    if (!undisclosedTerms.has(hit.term)) continue;
    if (!hitsByTerm.has(hit.term)) hitsByTerm.set(hit.term, []);
    hitsByTerm.get(hit.term)!.push(hit.source);
  }

  const description =
    `Found ${undisclosedList.length} undisclosed fee term${undisclosedList.length === 1 ? "" : "s"} charged on your storefront (${undisclosedList.join(", ")}) ` +
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
