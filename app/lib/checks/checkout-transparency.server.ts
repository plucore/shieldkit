/**
 * CHECK 6 — checkout_transparency
 *
 * Looks for signs that the storefront advertises accepted payment methods.
 * This is a TRUST BEST-PRACTICE, not a Google Merchant Center requirement —
 * Google removed the "display payment methods before checkout" rule in 2021 —
 * so this check is informational (severity "info") and never fails a store.
 *
 * Detection is broad on purpose (many themes render payment icons as inline
 * SVGs whose name lives only in <title>/id/aria-labelledby, inject them with
 * JavaScript, or expose them via data-enabled-payment-types / Shop Pay
 * buttons): we check icon markup, accessible names, payment data attributes,
 * and dynamic-checkout button markup.
 */

import type { CheckResult } from "./types";
import { detectPaymentSignals } from "./shared/html-detectors.server";

export async function checkCheckoutTransparency(
  storeUrl: string,
  homepageHtml: string | null
): Promise<CheckResult> {
  const CHECK_NAME = "checkout_transparency";

  if (!homepageHtml) {
    return {
      check_name: CHECK_NAME,
      passed: true,
      severity: "info",
      title: "Payment Methods — Not Verified",
      description:
        "The public storefront homepage could not be fetched, so accepted " +
        "payment methods could not be checked. Displaying payment methods is a " +
        "trust best-practice, not a Google Merchant Center requirement.",
      fix_instruction:
        "Ensure your store is published and not password-protected, then re-run the scan.",
      raw_data: { store_url: storeUrl, error: "homepage_fetch_failed" },
    };
  }

  // Payment-icon detection (shared, HTML-only): brand keywords across img/use/
  // <title>/id/aria-labelledby/data attrs + structural dynamic-checkout markers.
  const { found, structural: structuralFound, detected } = detectPaymentSignals(homepageHtml);

  if (detected) {
    const summary =
      found.length > 0
        ? `payment method icon(s): ${found.join(", ")}`
        : `payment display markup: ${structuralFound.join(", ")}`;
    return {
      check_name: CHECK_NAME,
      passed: true,
      severity: "info",
      title: "Payment Methods Displayed",
      description: `Storefront advertises accepted payment methods (${summary}).`,
      fix_instruction: "No action required.",
      raw_data: {
        store_url: storeUrl,
        payment_icons_found: found,
        structural_signals: structuralFound,
      },
    };
  }

  return {
    check_name: CHECK_NAME,
    passed: true,
    severity: "info",
    title: "Payment Methods — Not Detected",
    description:
      "No payment method icons were detected in your storefront's initial HTML. " +
      "This is a trust best-practice, not a Google Merchant Center requirement, and " +
      "automated scans can miss icons that load via JavaScript — so no action may be needed.",
    fix_instruction:
      "Payment icons usually appear automatically once a provider is active. " +
      "Verify your providers under Shopify Admin → Settings → Payments. Most themes " +
      "then render the icons from your active gateways (some themes also expose a " +
      "payment-icons toggle in the theme editor).",
    raw_data: { store_url: storeUrl, payment_icons_found: [], structural_signals: [] },
  };
}
