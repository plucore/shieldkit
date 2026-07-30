/**
 * app/lib/checks/index.server.ts
 *
 * Main orchestrator: imports all 12 check functions, runs them via safeCheck,
 * persists results to Supabase, and returns the full scan + violations.
 */

import {
  createAdminClient,
  getShopInfo,
  getShopPolicies,
  getProductsWithAvailability,
  getPagesWithAvailability,
} from "../shopify-api.server";
import { supabase } from "../../supabase.server";
import { sentry } from "../sentry.server";
import { fetchPublicPage } from "./helpers.server";
import { safeCheck } from "./safe-check.server";
import { computeComplianceScore, isScorable } from "./compliance-score";
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
import {
  pendingPageSpeed,
  PAGE_SPEED_TRIGGER,
} from "./page-speed.server";
import { checkBusinessIdentityConsistency } from "./business-identity-consistency.server";
import { checkHiddenFeeDetection } from "./hidden-fee-detection.server";
import { checkImageHostingAudit } from "./image-hosting-audit.server";

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
  const [shopInfo, shopPolicies, productsResult, pagesResult] = await Promise.all([
    getShopInfo(executor),
    getShopPolicies(executor),
    getProductsWithAvailability(executor, 50),
    getPagesWithAvailability(executor, 20),
  ]);
  const pages = pagesResult.pages;
  const products = productsResult.products;

  // ── 2b. Opportunistically refresh merchant metadata from Shopify ────────────
  // Fire-and-forget: keeps shop_name, owner, country, plan, etc. in sync on
  // every scan. Failures are logged but never abort the scan.
  if (shopInfo) {
    void supabase
      .from("merchants")
      .update({
        shop_name: shopInfo.name,
        shop_owner_name: shopInfo.shopOwnerName,
        contact_email: shopInfo.contactEmail,
        country: shopInfo.billingAddress.country,
        province: shopInfo.billingAddress.province,
        city: shopInfo.billingAddress.city,
        currency_code: shopInfo.currencyCode,
        shopify_plan: shopInfo.plan.displayName,
        primary_domain: shopInfo.primaryDomain.host,
        shop_created_at: shopInfo.createdAt,
        iana_timezone: shopInfo.ianaTimezone,
        shop_metadata_refreshed_at: new Date().toISOString(),
      })
      .eq("id", merchantId)
      .then((result: { error: { message: string } | null }) => {
        if (result.error) {
          console.error(
            `[Scanner] Failed to refresh merchant metadata for ${shopifyDomain}:`,
            result.error.message,
          );
        }
      });
  }

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

  // ── 4. Run all 12 checks ────────────────────────────────────────────────────
  // Every call goes through safeCheck() so a single check throwing never
  // aborts the scan — it records an "error" severity result instead.
  //
  // Checks 1–5 (Fatal Five) are wrapped concurrently; they are synchronous
  // internally but Promise.all lets safeCheck handle any edge-case throws.
  // Checks 6–10 are naturally async and also run concurrently.
  //
  // Both batches run concurrently with each other (Promise.all is not awaited
  // until after both are submitted).

  const [
    fatalFiveResults,
    [check6, check7, check8, check9, check10, check11, check12],
  ] =
    await Promise.all([
      Promise.all([
        safeCheck("contact_information", () =>
          checkContactInformation(pages, shopInfo, homepageFetch?.html ?? null)
        ),
        safeCheck("refund_return_policy", () =>
          checkRefundPolicy(shopPolicies, pages)
        ),
        safeCheck("shipping_policy", () =>
          checkShippingPolicy(shopPolicies, pages)
        ),
        safeCheck("privacy_and_terms", () =>
          checkPrivacyAndTerms(shopPolicies, pages)
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
        // Synchronous and network-free: PageSpeed Insights moved to
        // api.cron.measure-page-speed, which patches this row on its own 60s
        // invocation. Inline, a 30s PSI abort failed on ~2 of every 3 scans.
        safeCheck("page_speed", async () => pendingPageSpeed(storeUrl)),
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
        safeCheck("image_hosting_audit", () =>
          checkImageHostingAudit(products),
        ),
      ]),
    ]);

  // ── DATA-AVAILABILITY DEGRADATION ─────────────────────────────────────────
  //
  // RULE: never report a compliance failure derived from a fetch that failed.
  //
  // The four checks below read Shopify Settings → Policies (plus shop contact
  // info) through the Admin API. When that fetch failed, getShopPolicies()
  // used to return an all-null result indistinguishable from "this shop has no
  // policies", and all four reported CRITICAL at once. `critical_count = 4` was
  // the only bucket in the entire scans table that co-occurred with
  // `shop_info_unavailable` (9 of 17; 0 of 98 in every other bucket). Three
  // paying merchants watched their score flip between 91.67 and 58.33 — once 94
  // minutes apart with no change to their store — and churned.
  //
  // Rather than thread a flag through four check signatures, the override lives
  // here in one auditable place: if the upstream data was unavailable, the
  // check's verdict is replaced with a non-scorable INFO, excluded from both
  // the numerator and denominator of the score exactly as page_speed already is
  // when Google's API times out.
  const degradedChecks: string[] = [];
  const degradeUnverifiable = (r: CheckResult, what: string): CheckResult => {
    degradedChecks.push(r.check_name);
    return {
      ...r,
      passed: true, // not a failure — we simply could not look
      severity: "info",
      scorable: false, // excluded from BOTH sides of the score
      title: `${r.title.split(" — ")[0]} — Not Checked`,
      description:
        `We could not read your ${what} from Shopify this time, so this was not ` +
        `checked and has not affected your score. This is on our side, not yours — ` +
        `it is usually a temporary Shopify API hiccup. Re-run the scan in a few minutes.`,
      fix_instruction: "No action needed. Re-run the scan.",
      raw_data: {
        ...r.raw_data,
        degraded: true,
        degraded_reason: "shopify_admin_api_unavailable",
        original_severity: r.severity,
        original_passed: r.passed,
      },
    };
  };

  // BOTH sources must be available before a policy check may report absence.
  // `pages` is the FALLBACK source, and the checks literally say "not found in
  // Settings → Policies OR AS A SHOPIFY PAGE" — so an empty `pages` caused by a
  // failed fetch makes that sentence a false assertion. Before getPages got its
  // own flag this was a live divergence: the policies retry could succeed while
  // getPages failed, yielding available:true + pages:[] and an un-degraded
  // CRITICAL.
  const policiesUnavailable = !shopPolicies.available || !pagesResult.available;
  const fatalFive: CheckResult[] = fatalFiveResults.map((r) => {
    if (
      policiesUnavailable &&
      (r.check_name === "refund_return_policy" ||
        r.check_name === "shipping_policy" ||
        r.check_name === "privacy_and_terms")
    ) {
      return degradeUnverifiable(r, "store policies");
    }
    // contact_information also loses a signal when shopInfo is null, but it is
    // 1-of-N across pages + homepage markup, so degrade it only when it FAILED
    // and its Admin-API input was missing — otherwise a pass stands on its own.
    if (!shopInfo && !r.passed && r.check_name === "contact_information") {
      return degradeUnverifiable(r, "store contact details");
    }
    return r;
  });

  if (degradedChecks.length > 0) {
    sentry.captureMessage(
      `Scan DEGRADED for ${shopifyDomain} — Admin API unavailable, ${degradedChecks.length} check(s) not scored: ${degradedChecks.join(", ")}`,
      "warning",
    );
    console.warn(
      `[Scanner] DEGRADED scan for ${shopifyDomain}: ${degradedChecks.join(", ")} could not be verified and were excluded from the score.`,
    );
  }

  // hidden_fee_detection consumes shopPolicies too, but sits in the SECOND batch
  // which the map above never touched — a hole in the degradation shipped
  // earlier on 2026-07-28. With unavailable policies its `policyText` is empty,
  // so EVERY storefront fee mention becomes "undisclosed" and it emits a
  // CRITICAL "Undisclosed Fees Detected". Degrade it on the same gate.
  const check11Degraded =
    !shopPolicies.available && check11.check_name === "hidden_fee_detection"
      ? degradeUnverifiable(check11, "store policies")
      : check11;

  // Products were the last Admin-API source with no availability flag: a
  // throttle or a stale-token 401 returned `[]`, and an empty catalog makes
  // every product-derived check pass VACUOUSLY — a better score than the
  // merchant earned. Degrade them on the same gate so "we could not read your
  // catalog" can never be scored as "your catalog is fine".
  //
  // Only applied when the check PASSED: a product-derived FAILURE found in the
  // partial results we did read is still a real finding worth showing.
  const degradeIfProductsUnavailable = (r: CheckResult): CheckResult =>
    !productsResult.available &&
    r.passed &&
    (r.check_name === "product_data_quality" ||
      r.check_name === "structured_data_json_ld" ||
      r.check_name === "image_hosting_audit")
      ? degradeUnverifiable(r, "product catalog")
      : r;

  const checkResults: CheckResult[] = [
    ...fatalFive,
    check6,
    check7,
    check8,
    check9,
    check10,
    check11Degraded,
    check12,
  ].map(degradeIfProductsUnavailable);

  // ── 5. Aggregate scores and counts ──────────────────────────────────────────
  const totalChecks = checkResults.length; // 11+ as new checks are added in v2
  const passedChecks = checkResults.filter((r) => r.passed).length;
  const failedChecks = checkResults.filter((r) => !r.passed);

  const criticalCount = failedChecks.filter((r) => r.severity === "critical").length;
  const warningCount  = failedChecks.filter((r) => r.severity === "warning").length;
  const infoCount     = failedChecks.filter((r) => r.severity === "info").length;

  // Errored checks AND unmeasurable checks (scorable === false, e.g. page_speed
  // when Google's PageSpeed API times out) are excluded from BOTH the numerator
  // and the denominator, so a transient external failure never moves the score.
  // See compliance-score.ts.
  const { complianceScore } = computeComplianceScore(checkResults);

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

  // ── 6b. Score-collapse alarm ──────────────────────────────────────────────
  //
  // An implausible drop between two consecutive scans of the same store is
  // almost always ours, not theirs: policies and contact details do not vanish
  // and reappear. This is the alarm that would have surfaced the 2026 May–June
  // incident in days instead of after three customers had churned. Non-blocking
  // and never allowed to fail the scan.
  try {
    const { data: prev } = await supabase
      .from("scans")
      .select("compliance_score, critical_count, created_at")
      .eq("merchant_id", merchantId)
      .neq("id", scanId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (prev) {
      const prevScore = Number(prev.compliance_score ?? 0);
      const prevCrit = Number(prev.critical_count ?? 0);
      const scoreDrop = prevScore - complianceScore;
      const criticalJump = criticalCount - prevCrit;
      // Either a >20-point collapse, or 0 criticals turning into several.
      //
      // The threshold is 3, not 4. The historical signature was FOUR criticals
      // (contact_information, privacy_and_terms, refund_return_policy,
      // shipping_policy), but the 2026-07-09 false-positive remediation demoted
      // contact_information to a 1-of-N warning — so the same data-unavailability
      // can now produce at most THREE criticals. A `>= 4` threshold was therefore
      // unreachable for the very failure mode it was written to catch; found by
      // forcing the failure in tests/trust-fix-failure-modes.test.ts rather than
      // by reading the code.
      const CRITICAL_JUMP_ALARM = 3;
      if (
        scoreDrop > 20 ||
        (prevCrit === 0 && criticalCount >= CRITICAL_JUMP_ALARM)
      ) {
        sentry.captureMessage(
          `IMPLAUSIBLE SCORE COLLAPSE for ${shopifyDomain}: ${prevScore} -> ${complianceScore} ` +
            `(drop ${scoreDrop.toFixed(2)}), criticals ${prevCrit} -> ${criticalCount} ` +
            `(+${criticalJump}). Previous scan ${prev.created_at}. Suspect a data-availability ` +
            `failure rather than a real regression — verify before trusting this scan.`,
          "warning",
        );
        console.warn(
          `[Scanner] IMPLAUSIBLE COLLAPSE ${shopifyDomain}: score ${prevScore}->${complianceScore}, criticals ${prevCrit}->${criticalCount}`,
        );
      }
    }
  } catch (err) {
    console.warn(
      "[Scanner] score-collapse check failed (non-fatal):",
      err instanceof Error ? err.message : err,
    );
  }

  // ── 7. Persist: bulk INSERT all violation rows ───────────────────────────────
  // A synthetic `scan_data_availability` row is the scan-level DEGRADED marker.
  // Deliberately a violation row rather than a new `scans` column: it needs no
  // migration, it surfaces in the merchant's checklist so a partial scan is
  // never silently presented as a full compliance verdict, and it is queryable
  // for the same forensics that found this bug. A dedicated `scans.degraded`
  // boolean would be tidier and is queued for the next migration.
  const violationRows = checkResults.map((r) => ({
    scan_id: scanId,
    check_name: r.check_name,
    passed: r.passed,
    severity: r.severity,
    title: r.title,
    description: r.description,
    fix_instruction: r.fix_instruction,
    raw_data: r.raw_data,
    // Did this row count toward compliance_score? `scorable` was a transient
    // in-memory hint, so a stored unmeasurable check was byte-identical to a
    // genuine pass (passed=true, severity='info') and SQL could not tell which
    // rows the score excluded. That gap produced a false positive in an audit of
    // this database on 2026-07-29. Persisting isScorable() — the SAME predicate
    // the score uses, not a second rule that can drift — makes
    // `count(*) FILTER (WHERE scorable)` reproduce the denominator exactly.
    scorable: isScorable(r),
  }));

  if (degradedChecks.length > 0) {
    violationRows.push({
      scan_id: scanId,
      check_name: "scan_data_availability",
      passed: false,
      severity: "info",
      title: "Partial Scan — Some Checks Skipped",
      description:
        `We could not reach Shopify for part of this scan, so ${degradedChecks.length} ` +
        `check(s) were skipped and excluded from your score: ${degradedChecks.join(", ")}. ` +
        `Your score reflects only what we could actually verify.`,
      fix_instruction: "Nothing to fix. Re-run the scan in a few minutes for a complete result.",
      raw_data: { degraded: true, skipped_checks: degradedChecks },
      // A scan-level marker, not a check: it is not in checkResults and so never
      // reached computeComplianceScore. false is the accurate record, and it
      // keeps `count(*) FILTER (WHERE scorable)` equal to the real denominator.
      scorable: false,
    });
  }

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

  // ── 8. Queue the deferred PageSpeed measurement ──────────────────────────
  //
  // The page_speed row above is a non-scorable placeholder; the real PSI call
  // runs in api.cron.measure-page-speed, which has a whole 60s invocation to
  // spend instead of a 30s slice of this one. Enqueued AFTER the violations
  // insert so the row the cron patches is guaranteed to exist.
  //
  // Fire-and-forget by design: a queue failure must never fail a scan the
  // merchant already paid a quota for. The worst case is a page_speed row that
  // stays "checking in the background", which is exactly what it says.
  try {
    const { error: queueErr } = await supabase.from("pending_scan_triggers").insert({
      merchant_id: merchantId,
      trigger_type: PAGE_SPEED_TRIGGER,
      payload: { scan_id: scanId, store_url: storeUrl },
    });
    if (queueErr) {
      console.warn(
        `[Scanner] could not queue page_speed measurement for scan ${scanId}: ${queueErr.message}`,
      );
    }
  } catch (err) {
    console.warn(
      `[Scanner] page_speed enqueue threw for scan ${scanId}:`,
      err instanceof Error ? err.message : err,
    );
  }

  return {
    scan: scanData as ScanRecord,
    violations: (violationsData ?? []) as ScanViolation[],
  };
}
