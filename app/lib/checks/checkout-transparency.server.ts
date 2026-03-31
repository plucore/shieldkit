/**
 * CHECK 6 — checkout_transparency
 *
 * Scans the public storefront homepage for payment method icons.
 * GMC buyers expect to see accepted payment methods displayed before checkout.
 * Detects icons via <img> src/alt, SVG <use> href, and CSS class names.
 */

import { load as cheerioLoad } from "cheerio";
import type { CheckResult } from "./types";
import { PAYMENT_KEYWORDS } from "./constants";

export async function checkCheckoutTransparency(
  storeUrl: string,
  homepageHtml: string | null
): Promise<CheckResult> {
  const CHECK_NAME = "checkout_transparency";

  if (!homepageHtml) {
    return {
      check_name: CHECK_NAME,
      passed: false,
      severity: "warning",
      title: "Checkout Transparency — Unable to Scan",
      description:
        "The public storefront could not be fetched. Payment method icon " +
        "detection requires the homepage to be publicly accessible.",
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

  // SVG <use> elements — sprite sheet references
  $("use").each((_, el) => {
    checkText($(el).attr("xlink:href") ?? "");
    checkText($(el).attr("href") ?? "");
  });

  // Any element with a class name (e.g. "icon--visa", "payment-icon__mastercard")
  $("[class]").each((_, el) => {
    checkText($(el).attr("class") ?? "");
  });

  // Aria labels and data attributes
  $("[aria-label], [data-payment-icon], [data-method]").each((_, el) => {
    checkText($(el).attr("aria-label") ?? "");
    checkText($(el).attr("data-payment-icon") ?? "");
    checkText($(el).attr("data-method") ?? "");
  });

  const found = Array.from(foundIcons);
  const passed = found.length > 0;

  if (passed) {
    return {
      check_name: CHECK_NAME,
      passed: true,
      severity: "info",
      title: "Checkout Transparency",
      description: `${found.length} payment method icon(s) detected on the storefront: ${found.join(", ")}.`,
      fix_instruction: "No action required.",
      raw_data: { store_url: storeUrl, payment_icons_found: found, icons_count: found.length },
    };
  }

  return {
    check_name: CHECK_NAME,
    passed: false,
    severity: "warning",
    title: "No Payment Method Icons Detected",
    description:
      "No recognisable payment method icons were found on your storefront homepage. " +
      "Google Merchant Center and shoppers expect to see accepted payment methods " +
      "clearly displayed before checkout.",
    fix_instruction:
      "1. In Shopify Admin → Online Store → Themes, open your active theme's settings.\n" +
      "2. Navigate to Theme settings → Footer and ensure payment icons are enabled.\n" +
      "3. Most Shopify themes automatically show payment icons based on your active " +
      "gateways. Verify your providers are active under Settings → Payments.\n" +
      "4. If using a custom theme, manually add payment icon SVGs or images to your footer.",
    raw_data: { store_url: storeUrl, payment_icons_found: [], icons_count: 0 },
  };
}
