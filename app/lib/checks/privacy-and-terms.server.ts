/**
 * CHECK 4 — privacy_and_terms
 *
 * Checks for the presence of a Privacy Policy (critical if absent — legally
 * required in most jurisdictions and by GMC) and Terms of Service (warning
 * if absent). Both must be present for the check to pass.
 *
 * Detection order (privacy and terms evaluated independently):
 *   1. Shopify Settings → Policies → Privacy / Terms entries.
 *   2. Fallback: Shopify Page with handle/title matching /privacy/i or
 *      /terms|tos|conditions/i. If found with a non-blank body it counts
 *      toward presence; the result surfaces an info-severity advisory in
 *      raw_data so the merchant knows to move it.
 *   3. Neither → fail as before.
 *
 * TODO (researched 2026-05-05): extend with Customer Privacy / cookie-banner
 * status. Shopify Admin GraphQL exposes a stable surface:
 *
 *   query { privacySettings { banner { enabled autoManaged } } }
 *   query ConsentPolicy { consentPolicy { consentRequired countryCode } }
 *
 * Required scope: `read_privacy_settings` (NOT currently in shopify.app.toml
 * — would need a separate scope re-review cycle, similar to write_products).
 */

import type { Page, ShopPoliciesResult } from "../shopify-api.server";
import type { CheckResult } from "./types";
import { findPolicyPage } from "./helpers.server";

const PRIVACY_PAGE_PATTERN = /privacy/i;
const TERMS_PAGE_PATTERN = /terms|tos|conditions/i;

export function checkPrivacyAndTerms(
  policies: ShopPoliciesResult,
  pages: Page[] = [],
): CheckResult {
  const CHECK_NAME = "privacy_and_terms";
  const privacy = policies.PRIVACY_POLICY;
  const terms = policies.TERMS_OF_SERVICE;

  const privacyHasBody = !!privacy?.body?.trim();
  const termsHasBody = !!terms?.body?.trim();

  // Page-fallback lookups (only consulted when the Settings → Policies
  // counterpart is missing).
  const privacyPage = privacyHasBody ? null : findPolicyPage(pages, PRIVACY_PAGE_PATTERN);
  const termsPage = termsHasBody ? null : findPolicyPage(pages, TERMS_PAGE_PATTERN);

  const privacyPresent = privacyHasBody || !!privacyPage;
  const termsPresent = termsHasBody || !!termsPage;

  const privacySource: "policy" | "page" | "missing" = privacyHasBody
    ? "policy"
    : privacyPage
      ? "page"
      : "missing";
  const termsSource: "policy" | "page" | "missing" = termsHasBody
    ? "policy"
    : termsPage
      ? "page"
      : "missing";

  const raw_data: Record<string, unknown> = {
    privacy_policy_present: privacyPresent,
    privacy_policy_source: privacySource,
    privacy_policy_url: privacy?.url ?? privacyPage?.url ?? null,
    privacy_page_handle: privacyPage?.handle ?? null,
    terms_of_service_present: termsPresent,
    terms_of_service_source: termsSource,
    terms_of_service_url: terms?.url ?? termsPage?.url ?? null,
    terms_page_handle: termsPage?.handle ?? null,
  };

  // ── Both present ─────────────────────────────────────────────────────────
  if (privacyPresent && termsPresent) {
    // If either came from a Page, surface an info advisory so the merchant
    // moves it into Settings → Policies.
    const pageFallbacks: string[] = [];
    if (privacySource === "page" && privacyPage)
      pageFallbacks.push(`privacy at /pages/${privacyPage.handle}`);
    if (termsSource === "page" && termsPage)
      pageFallbacks.push(`terms at /pages/${termsPage.handle}`);

    if (pageFallbacks.length > 0) {
      return {
        check_name: CHECK_NAME,
        passed: true,
        severity: "info",
        title: "Policy detected on page, not in Settings → Policies",
        description:
          `Your ${pageFallbacks.join(" and ")} ${pageFallbacks.length > 1 ? "were" : "was"} ` +
          "found but isn't registered in Settings → Policies. Google " +
          "Merchant Center reviewers and shoppers expect legal policies " +
          "linked from your store footer.",
        fix_instruction:
          "In Shopify admin, go to Settings → Policies and paste your " +
          "policy content there. Shopify will auto-link it in your store " +
          "footer.",
        raw_data,
      };
    }

    return {
      check_name: CHECK_NAME,
      passed: true,
      severity: "info",
      title: "Privacy Policy & Terms of Service",
      description: "Both Privacy Policy and Terms of Service are present.",
      fix_instruction: "No action required.",
      raw_data,
    };
  }

  // ── Privacy missing ──────────────────────────────────────────────────────
  if (!privacyPresent) {
    const missingBoth = !termsPresent;
    return {
      check_name: CHECK_NAME,
      passed: false,
      severity: "critical",
      title: missingBoth
        ? "Missing Privacy Policy and Terms of Service"
        : "Missing Privacy Policy",
      description: missingBoth
        ? "Neither a Privacy Policy nor Terms of Service was found in " +
          "Settings → Policies or as a Shopify Page. A Privacy Policy is " +
          "legally required (GDPR, CCPA, PIPEDA) and mandatory for Google " +
          "Merchant Center approval."
        : "No Privacy Policy was found. This is legally required under GDPR, " +
          "CCPA, and other privacy laws, and is mandatory for Google " +
          "Merchant Center approval.",
      fix_instruction:
        "1. In Shopify Admin → Settings → Policies, create a Privacy Policy " +
        "(Shopify provides a starting template you can adapt).\n" +
        "2. Customise it to reflect your actual data practices " +
        "(what data you collect, how it is used, third-party sharing).\n" +
        "3. Ensure the policy is linked in your store footer.\n" +
        (missingBoth
          ? "4. Also create a Terms of Service covering purchase terms, " +
            "liability limitations, and governing law."
          : ""),
      raw_data,
    };
  }

  // ── Privacy present, terms missing → warning ─────────────────────────────
  return {
    check_name: CHECK_NAME,
    passed: false,
    severity: "warning",
    title: "Missing Terms of Service",
    description:
      "Privacy Policy is present, but no Terms of Service was found in " +
      "Settings → Policies or as a Shopify Page. Terms of Service establish " +
      "the legal framework for customer purchases and are strongly " +
      "recommended for GMC-listed stores.",
    fix_instruction:
      "1. In Shopify Admin → Settings → Policies, create a Terms of Service " +
      "(Shopify provides a starting template you can adapt).\n" +
      "2. Review and customise it — particularly sections covering " +
      "payment terms, liability, and governing law.\n" +
      "3. Link the Terms of Service in your store footer.",
    raw_data,
  };
}
