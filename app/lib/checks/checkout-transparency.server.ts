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

import { load as cheerioLoad } from "cheerio";
import type { CheckResult } from "./types";
import { PAYMENT_KEYWORDS } from "./constants";

// Structural markers that indicate payment methods are advertised even when no
// individual brand keyword is present (Shopify dynamic checkout / footer lists).
const STRUCTURAL_SIGNALS = [
  "data-enabled-payment-types",
  "shopify-payment-button",
  "shop-pay",
  "dynamic-checkout",
  "additional-checkout-buttons",
  "payment-icons",
  "list-payment",
  "icon--payment",
  "payment-icon",
];

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

  const $ = cheerioLoad(homepageHtml);

  const foundIcons = new Set<string>();
  const checkText = (text: string) => {
    const lower = text.toLowerCase();
    for (const kw of PAYMENT_KEYWORDS) {
      if (lower.includes(kw)) foundIcons.add(kw);
    }
  };

  // <img> — src and alt attributes
  $("img").each((_, el) => {
    checkText($(el).attr("src") ?? "");
    checkText($(el).attr("alt") ?? "");
  });

  // SVG <use> sprite references
  $("use").each((_, el) => {
    checkText($(el).attr("xlink:href") ?? "");
    checkText($(el).attr("href") ?? "");
  });

  // SVG <title> element TEXT — Shopify's stock payment icons put the brand
  // name here (e.g. <title id="pi-visa">Visa</title>), never in an attribute
  // the older detector scanned.
  $("title").each((_, el) => {
    checkText($(el).text());
  });

  // Accessible names and identifiers: class, id, aria-label, aria-labelledby
  // (Shopify uses id/aria-labelledby="pi-visa" etc.) + payment data attributes.
  $("[class], [id], [aria-label], [aria-labelledby], [data-payment-icon], [data-method], [data-enabled-payment-types], [data-payment-type]").each(
    (_, el) => {
      checkText($(el).attr("class") ?? "");
      checkText($(el).attr("id") ?? "");
      checkText($(el).attr("aria-label") ?? "");
      checkText($(el).attr("aria-labelledby") ?? "");
      checkText($(el).attr("data-payment-icon") ?? "");
      checkText($(el).attr("data-method") ?? "");
      checkText($(el).attr("data-enabled-payment-types") ?? "");
      checkText($(el).attr("data-payment-type") ?? "");
    }
  );

  // Structural signals (dynamic checkout buttons, footer payment lists).
  const lowerHtml = homepageHtml.toLowerCase();
  const structuralFound = STRUCTURAL_SIGNALS.filter((s) => lowerHtml.includes(s));

  const found = Array.from(foundIcons);
  const detected = found.length > 0 || structuralFound.length > 0;

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
