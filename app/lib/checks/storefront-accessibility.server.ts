/**
 * CHECK 7 — storefront_accessibility
 *
 * Verifies the storefront is publicly accessible (not password-protected) and
 * that sampled product pages respond with HTTP 200.
 */

import { load as cheerioLoad } from "cheerio";
import type { CheckResult, PageFetchResult } from "./types";

export async function checkStorefrontAccessibility(
  storeUrl: string,
  productPageResults: PageFetchResult[],
  homepageStatus: number | null,
  homepageHtml: string | null
): Promise<CheckResult> {
  const CHECK_NAME = "storefront_accessibility";

  // ── Password-protection detection ─────────────────────────────────────────
  let isPasswordProtected = false;
  const passwordSignals: string[] = [];

  if (homepageStatus === 401) {
    isPasswordProtected = true;
    passwordSignals.push("HTTP 401 Unauthorized");
  }

  if (homepageHtml) {
    const $ = cheerioLoad(homepageHtml);
    const bodyClass = ($("body").attr("class") ?? "").toLowerCase();
    const pageTitle = $("title").text().toLowerCase();

    if (bodyClass.includes("template-password")) {
      isPasswordProtected = true;
      passwordSignals.push('body class "template-password" detected');
    }
    if (
      pageTitle.includes("enter using password") ||
      pageTitle.includes("password required")
    ) {
      isPasswordProtected = true;
      passwordSignals.push(`page title indicates password gate: "${$("title").text()}"`);
    }
    if ($("form[action='/password']").length > 0) {
      isPasswordProtected = true;
      passwordSignals.push('password form (action="/password") present');
    }
    if ($("#shopify-challenge-page").length > 0) {
      isPasswordProtected = true;
      passwordSignals.push("#shopify-challenge-page element detected");
    }
  }

  if (isPasswordProtected) {
    return {
      check_name: CHECK_NAME,
      passed: false,
      severity: "critical",
      title: "Storefront is Password Protected",
      description:
        "Your store is behind a password page and is not publicly accessible. " +
        "Google Merchant Center can't see or approve products from password-protected stores.",
      fix_instruction:
        "1. In Shopify Admin → Online Store → Preferences, scroll to 'Password protection'.\n" +
        "2. Uncheck 'Restrict access to visitors with the password' and save.\n" +
        "3. Ensure your store is on an active paid Shopify plan — free trial stores " +
        "are password-protected by default.",
      raw_data: {
        store_url: storeUrl,
        homepage_status: homepageStatus,
        password_protected: true,
        password_signals: passwordSignals,
        product_checks: productPageResults.map((r) => ({ url: r.url, status: r.status })),
      },
    };
  }

  // ── Product page reachability ──────────────────────────────────────────────
  //
  // `status !== 200` used to be the whole test, which conflated three different
  // things — and this check has already fired wrongly because of it
  // (normae-shop.com, 2026-04-20: a single transient HTTP 503 on one of three
  // product pages, the other two returning 200):
  //
  //   404 / 410      the product page genuinely is not published — a REAL finding
  //   429/503/403/5xx rate-limited, down, bot-challenged — "we could not look"
  //   null           timeout / DNS / SSRF pre-check refusal — "we could not look"
  //
  // Only the definitive class may be reported as a failure. The rest degrade to a
  // non-scorable info so a transient blip on the merchant's CDN can never be
  // presented to them as a broken storefront.
  const isDefinitivelyMissing = (s: number | null) => s === 404 || s === 410;
  const isUnreachable = (s: number | null) => s !== null && !isDefinitivelyMissing(s) && (s < 200 || s >= 300);

  const missingPages = productPageResults.filter((r) => isDefinitivelyMissing(r.status));
  const unreachablePages = productPageResults.filter(
    (r) => r.status === null || isUnreachable(r.status),
  );

  const raw_data = {
    store_url: storeUrl,
    homepage_status: homepageStatus,
    password_protected: false,
    product_checks: productPageResults.map((r) => ({ url: r.url, status: r.status })),
    failed_product_pages: missingPages.length,
    unreachable_product_pages: unreachablePages.length,
  };

  // Definitive absence wins: a genuine 404 is a real finding even if another page
  // was merely unreachable.
  if (missingPages.length > 0 && productPageResults.length > 0) {
    return {
      check_name: CHECK_NAME,
      passed: false,
      severity: "warning",
      title: "Some Product Pages Aren't Loading",
      description:
        `${missingPages.length} of ${productPageResults.length} product page(s) we checked ` +
        `aren't loading correctly: ${missingPages.map((r) => r.url).join(", ")}. Shoppers and ` +
        `Google may not be able to see these products.`,
      fix_instruction:
        "1. In Shopify Admin → Products, verify the affected products are published " +
        "to the Online Store sales channel.\n" +
        "2. If a product handle has changed, update any feeds pointing to the old URL.\n" +
        "3. Check that the product is not archived (Products → filter by 'Archived').",
      raw_data,
    };
  }

  // Some pages were unreachable but none was definitively missing: we do not have
  // grounds to tell the merchant their storefront is broken, and we also cannot
  // claim it is fine. Non-scorable info — excluded from both sides of the score.
  if (unreachablePages.length > 0 && productPageResults.length > 0) {
    return {
      check_name: CHECK_NAME,
      passed: true,
      severity: "info",
      scorable: false,
      title: "Product Pages — Not Checked",
      description:
        `We could not load ${unreachablePages.length} of ${productPageResults.length} ` +
        `product page(s) just now, so this was not checked and has not affected your ` +
        `score. That is usually a store or CDN rate-limiting an automated request, ` +
        `not a problem with your products. Re-run the scan in a few minutes.`,
      fix_instruction: "No action needed. Re-run the scan.",
      raw_data: {
        ...raw_data,
        degraded: true,
        degraded_reason: "product_page_fetch_unavailable",
        unreachable: unreachablePages.map((r) => ({ url: r.url, status: r.status })),
      },
    };
  }

  // The homepage status is only unknown when the homepage fetch itself failed —
  // in which case do not assert accessibility we never observed.
  if (homepageStatus === null) {
    return {
      check_name: CHECK_NAME,
      passed: true,
      severity: "info",
      scorable: false,
      title: "Storefront Accessibility — Not Checked",
      description:
        "We could not load your storefront just now, so this was not checked and has " +
        "not affected your score. Re-run the scan in a few minutes.",
      fix_instruction: "No action needed. Re-run the scan.",
      raw_data: { ...raw_data, degraded: true, degraded_reason: "homepage_fetch_unavailable" },
    };
  }

  return {
    check_name: CHECK_NAME,
    passed: true,
    severity: "info",
    title: "Storefront Accessibility",
    description:
      `Storefront is publicly accessible (HTTP ${homepageStatus}).` +
      (productPageResults.length > 0
        ? ` All ${productPageResults.length} sampled product page(s) returned HTTP 200.`
        : " No products with public URLs were available to sample."),
    fix_instruction: "No action required.",
    raw_data,
  };
}
