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
        "Google Merchant Center cannot crawl or approve products from password-protected stores.",
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
  const failedPages = productPageResults.filter((r) => r.status !== 200);

  const raw_data = {
    store_url: storeUrl,
    homepage_status: homepageStatus,
    password_protected: false,
    product_checks: productPageResults.map((r) => ({ url: r.url, status: r.status })),
    failed_product_pages: failedPages.length,
  };

  if (failedPages.length > 0 && productPageResults.length > 0) {
    return {
      check_name: CHECK_NAME,
      passed: false,
      severity: "warning",
      title: "Product Pages Returning Non-200 Status",
      description:
        `${failedPages.length} of ${productPageResults.length} sampled product page(s) did not ` +
        `return HTTP 200: ${failedPages.map((r) => `${r.url} (${r.status ?? "timeout"})`).join(", ")}.`,
      fix_instruction:
        "1. In Shopify Admin → Products, verify the affected products are published " +
        "to the Online Store sales channel.\n" +
        "2. If a product handle has changed, update any feeds pointing to the old URL.\n" +
        "3. Check that the product is not archived (Products → filter by 'Archived').",
      raw_data,
    };
  }

  return {
    check_name: CHECK_NAME,
    passed: true,
    severity: "info",
    title: "Storefront Accessibility",
    description:
      `Storefront is publicly accessible (HTTP ${homepageStatus ?? "unknown"}).` +
      (productPageResults.length > 0
        ? ` All ${productPageResults.length} sampled product page(s) returned HTTP 200.`
        : " No products with public URLs were available to sample."),
    fix_instruction: "No action required.",
    raw_data,
  };
}
