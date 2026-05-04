/**
 * app/lib/checks/index.server.ts
 *
 * Main orchestrator: imports all 10 check functions, runs them via safeCheck,
 * persists results to Supabase, and returns the full scan + violations.
 */

import {
  createAdminClient,
  getShopInfo,
  getShopPolicies,
  getProducts,
  getPages,
} from "../shopify-api.server";
import { supabase } from "../../supabase.server";
import { fetchPublicPage } from "./helpers.server";
import { safeCheck } from "./safe-check.server";
import type {
  CheckResult,
  PageFetchResult,
  ScanRecord,
  ScanViolation,
  ComplianceScanResult,
} from "./types";

// Individual check functions
import { checkContactInformation } from "./contact-information.server";
import { checkRefundPolicy } from "./refund-return-policy.server";
import { checkShippingPolicy } from "./shipping-policy.server";
import { checkPrivacyAndTerms } from "./privacy-and-terms.server";
import { checkProductDataQuality } from "./product-data-quality.server";
import { checkCheckoutTransparency } from "./checkout-transparency.server";
import { checkStorefrontAccessibility } from "./storefront-accessibility.server";
import { checkStructuredDataJsonLd } from "./structured-data-json-ld.server";
import { checkPageSpeed } from "./page-speed.server";
import { checkBusinessIdentityConsistency } from "./business-identity-consistency.server";
import { checkHiddenFeeDetection } from "./hidden-fee-detection.server";

// Re-export types
export type {
  Severity,
  CheckResult,
  ScanViolation,
  ScanRecord,
  ComplianceScanResult,
  PageFetchResult,
  PageReport,
  ProductIssue,
  FlaggedProduct,
} from "./types";

/**
 * Runs a full 10-check GMC compliance scan for a merchant.
 *
 * Checks 1–5  (Fatal Five):   synchronous, Shopify GraphQL data only.
 * Checks 6–10 (Advanced):     async, fetch public storefront + external APIs.
 *
 * Every individual check is wrapped in safeCheck() — if a check throws
 * unexpectedly (e.g. network timeout, parse error), that check is recorded
 * with severity "error" and the rest of the scan continues normally.
 *
 * @param merchantId    - UUID from the Supabase `merchants` table.
 * @param shopifyDomain - e.g. "mystore.myshopify.com"
 * @param scanType      - "manual" | "automated". Defaults to "manual".
 *
 * @throws If the Shopify admin client cannot be initialised (no stored token)
 *         or if the Supabase scan INSERT fails.
 */
export async function runComplianceScan(
  merchantId: string,
  shopifyDomain: string,
  scanType: "manual" | "automated" = "manual"
): Promise<ComplianceScanResult> {
  // ── 1. Initialise the Shopify data pipeline ─────────────────────────────────
  const executor = await createAdminClient(shopifyDomain);

  // ── 2. Fetch all Shopify data concurrently ──────────────────────────────────
  const [shopInfo, shopPolicies, products, pages] = await Promise.all([
    getShopInfo(executor),
    getShopPolicies(executor),
    getProducts(executor, 50),
    getPages(executor, 20),
  ]);

  // ── 3. Pre-fetch public storefront pages (shared by checks 6, 7, 8) ─────────
  // Prefer the custom domain; fall back to the myshopify domain.
  const storeUrl = shopInfo
    ? `https://${shopInfo.primaryDomain.host}`
    : `https://${shopifyDomain}`;

  // Collect up to 3 product page URLs for checks 7 (reachability) and 8 (JSON-LD).
  const productPageUrls = products
    .filter((p) => p.onlineStoreUrl)
    .slice(0, 3)
    .map((p) => p.onlineStoreUrl as string);

  // Fetch homepage and product pages in a single concurrent batch.
  const [homepageFetch, ...rawProductFetches] = await Promise.all([
    fetchPublicPage(storeUrl, 12_000),
    ...productPageUrls.map((url) => fetchPublicPage(url, 10_000)),
  ]);

  const productPageResults: PageFetchResult[] = productPageUrls.map((url, i) => ({
    url,
    status: rawProductFetches[i]?.status ?? null,
    html: rawProductFetches[i]?.html ?? null,
  }));

  // ── 4. Run all 10 checks ────────────────────────────────────────────────────
  // Every call goes through safeCheck() so a single check throwing never
  // aborts the scan — it records an "error" severity result instead.
  //
  // Checks 1–5 (Fatal Five) are wrapped concurrently; they are synchronous
  // internally but Promise.all lets safeCheck handle any edge-case throws.
  // Checks 6–10 are naturally async and also run concurrently.
  //
  // Both batches run concurrently with each other (Promise.all is not awaited
  // until after both are submitted).

  const [fatalFiveResults, [check6, check7, check8, check9, check10, check11]] =
    await Promise.all([
      Promise.all([
        safeCheck("contact_information", () =>
          checkContactInformation(pages, shopInfo)
        ),
        safeCheck("refund_return_policy", () =>
          checkRefundPolicy(shopPolicies)
        ),
        safeCheck("shipping_policy", () =>
          checkShippingPolicy(shopPolicies)
        ),
        safeCheck("privacy_and_terms", () =>
          checkPrivacyAndTerms(shopPolicies)
        ),
        safeCheck("product_data_quality", () =>
          checkProductDataQuality(products)
        ),
      ]),
      Promise.all([
        safeCheck("checkout_transparency", () =>
          checkCheckoutTransparency(storeUrl, homepageFetch?.html ?? null)
        ),
        safeCheck("storefront_accessibility", () =>
          checkStorefrontAccessibility(
            storeUrl,
            productPageResults,
            homepageFetch?.status ?? null,
            homepageFetch?.html ?? null
          )
        ),
        safeCheck("structured_data_json_ld", () =>
          checkStructuredDataJsonLd(productPageResults)
        ),
        safeCheck("page_speed", () => checkPageSpeed(storeUrl)),
        safeCheck("business_identity_consistency", () =>
          checkBusinessIdentityConsistency(shopInfo, pages, storeUrl)
        ),
        safeCheck("hidden_fee_detection", () =>
          checkHiddenFeeDetection(
            storeUrl,
            homepageFetch ?? null,
            productPageResults,
            shopPolicies,
          ),
        ),
      ]),
    ]);

  const checkResults: CheckResult[] = [
    ...fatalFiveResults,
    check6,
    check7,
    check8,
    check9,
    check10,
    check11,
  ];

  // ── 5. Aggregate scores and counts ──────────────────────────────────────────
  const totalChecks = checkResults.length; // 11+ as new checks are added in v2
  const passedChecks = checkResults.filter((r) => r.passed).length;
  const failedChecks = checkResults.filter((r) => !r.passed);

  const criticalCount = failedChecks.filter((r) => r.severity === "critical").length;
  const warningCount  = failedChecks.filter((r) => r.severity === "warning").length;
  const infoCount     = failedChecks.filter((r) => r.severity === "info").length;
  const errorCount    = failedChecks.filter((r) => r.severity === "error").length;

  // Errored checks are excluded from the compliance score denominator so a
  // transient network failure doesn't artificially lower a merchant's score.
  const scorableTotalChecks = totalChecks - errorCount;
  const complianceScore =
    scorableTotalChecks > 0
      ? Math.round((passedChecks / scorableTotalChecks) * 10_000) / 100
      : 0;

  // ── 6. Persist: INSERT scan row ──────────────────────────────────────────────
  const { data: scanData, error: scanError } = await supabase
    .from("scans")
    .insert({
      merchant_id: merchantId,
      scan_type: scanType,
      compliance_score: complianceScore,
      total_checks: totalChecks,
      passed_checks: passedChecks,
      critical_count: criticalCount,
      warning_count: warningCount,
      info_count: infoCount,
    })
    .select()
    .single();

  if (scanError || !scanData) {
    throw new Error(
      `[Scanner] Failed to insert scan record: ${scanError?.message ?? "no data returned"}`
    );
  }

  const scanId: string = (scanData as ScanRecord).id;

  // ── 7. Persist: bulk INSERT all 10 violation rows ────────────────────────────
  const violationRows = checkResults.map((r) => ({
    scan_id: scanId,
    check_name: r.check_name,
    passed: r.passed,
    severity: r.severity,
    title: r.title,
    description: r.description,
    fix_instruction: r.fix_instruction,
    raw_data: r.raw_data,
  }));

  const { data: violationsData, error: violationsError } = await supabase
    .from("violations")
    .insert(violationRows)
    .select();

  if (violationsError) {
    // Log but don't throw — the scan row is already committed.
    console.error(
      `[Scanner] Failed to insert violations for scan ${scanId}:`,
      violationsError.message
    );
  }

  return {
    scan: scanData as ScanRecord,
    violations: (violationsData ?? []) as ScanViolation[],
  };
}
