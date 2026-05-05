/**
 * CHECK 4 — privacy_and_terms
 *
 * Checks for the presence of a Privacy Policy (critical if absent — legally
 * required in most jurisdictions and by GMC) and Terms of Service (warning
 * if absent). Both must be present for the check to pass.
 *
 * TODO (researched 2026-05-05): extend with Customer Privacy / cookie-banner
 * status. Shopify Admin GraphQL exposes a stable surface:
 *
 *   query { privacySettings { banner { enabled autoManaged } } }
 *   query ConsentPolicy { consentPolicy { consentRequired countryCode } }
 *
 * Required scope: `read_privacy_settings` (NOT currently in shopify.app.toml
 * — would need a separate scope re-review cycle, similar to write_products).
 *
 * Docs:
 *   https://shopify.dev/docs/api/admin-graphql/latest/queries/privacySettings
 *   https://shopify.dev/docs/api/admin-graphql/latest/objects/CookieBanner
 *   https://shopify.dev/docs/api/admin-graphql/latest/queries/consentPolicy
 *
 * Once the scope lands, surface `banner.enabled` and the per-region
 * consentRequired matrix as a new sub-check. The weekly digest already has a
 * placeholder field (`customerPrivacyApiWired: null`) waiting to be populated.
 */

import type { ShopPoliciesResult } from "../shopify-api.server";
import type { CheckResult } from "./types";

export function checkPrivacyAndTerms(policies: ShopPoliciesResult): CheckResult {
  const CHECK_NAME = "privacy_and_terms";
  const privacy = policies.PRIVACY_POLICY;
  const terms = policies.TERMS_OF_SERVICE;

  const privacyPresent = !!(privacy?.body?.trim());
  const termsPresent = !!(terms?.body?.trim());

  const raw_data = {
    privacy_policy_present: privacyPresent,
    privacy_policy_url: privacy?.url ?? null,
    terms_of_service_present: termsPresent,
    terms_of_service_url: terms?.url ?? null,
  };

  if (privacyPresent && termsPresent) {
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
        ? "Neither a Privacy Policy nor Terms of Service was found. A Privacy " +
          "Policy is legally required (GDPR, CCPA, PIPEDA) and mandatory for " +
          "Google Merchant Center approval."
        : "No Privacy Policy was found. This is legally required under GDPR, " +
          "CCPA, and other privacy laws, and is mandatory for Google Merchant " +
          "Center approval.",
      fix_instruction:
        "1. In Shopify Admin → Settings → Policies, click 'Create from template' " +
        "under Privacy Policy to generate a baseline policy.\n" +
        "2. Customise it to reflect your actual data practices " +
        "(what data you collect, how it is used, third-party sharing).\n" +
        "3. Ensure the policy is linked in your store footer.\n" +
        (missingBoth
          ? "4. Also create a Terms of Service policy covering purchase terms, " +
            "liability limitations, and governing law."
          : ""),
      raw_data,
    };
  }

  // Privacy present, terms missing → warning
  return {
    check_name: CHECK_NAME,
    passed: false,
    severity: "warning",
    title: "Missing Terms of Service",
    description:
      "Privacy Policy is present, but no Terms of Service was found. " +
      "Terms of Service establish the legal framework for customer purchases " +
      "and are strongly recommended for GMC-listed stores.",
    fix_instruction:
      "1. In Shopify Admin → Settings → Policies, click 'Create from template' " +
      "under Terms of Service.\n" +
      "2. Review and customise the template — particularly sections covering " +
      "payment terms, liability, and governing law.\n" +
      "3. Link the Terms of Service in your store footer.",
    raw_data,
  };
}
