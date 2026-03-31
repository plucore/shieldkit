/**
 * CHECK 1 — contact_information
 *
 * Scans contact/about pages and the store billing address for three contact
 * methods: phone number, store-domain email, and physical street address.
 * The store must have at least 2 of the 3 publicly visible.
 */

import type { ShopInfo, Page } from "../shopify-api.server";
import type { CheckResult } from "./types";
import { stripHtml, extractDomain } from "./helpers.server";

export function checkContactInformation(
  pages: Page[],
  shopInfo: ShopInfo | null
): CheckResult {
  const CHECK_NAME = "contact_information";

  // ── Find relevant pages ──────────────────────────────────────────────────
  const contactPages = pages.filter((p) =>
    /contact|about/i.test(p.title + " " + p.handle)
  );
  const combinedText = contactPages
    .map((p) => stripHtml(p.body ?? ""))
    .join(" ");

  // ── Phone number detection (international formats) ───────────────────────
  // Covers: +1 (555) 555-5555 | 555.555.5555 | +44 7911 123456 | etc.
  const PHONE_RE =
    /(?:\+?1[-.\s]?)?\(?([2-9]\d{2})\)?[-.\s]([2-9]\d{2})[-.\s](\d{4})|\+[1-9]\d{1,2}[-.\s]\d{3,5}[-.\s]\d{3,5}(?:[-.\s]\d{2,4})?/g;
  const phoneFound = PHONE_RE.test(combinedText);

  // ── Email detection (must match primary store domain) ────────────────────
  const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@([a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/g;
  let emailFound = false;
  const storeDomain = shopInfo
    ? extractDomain(shopInfo.primaryDomain.host)
    : null;
  let match: RegExpExecArray | null;
  while ((match = EMAIL_RE.exec(combinedText)) !== null) {
    if (storeDomain && match[1].toLowerCase().includes(storeDomain)) {
      emailFound = true;
      break;
    }
  }

  // ── Physical address detection ────────────────────────────────────────────
  // Matches patterns like "123 Main Street", "456 Oak Ave"
  const ADDRESS_RE =
    /\d+\s+[A-Za-z]+(?:\s+[A-Za-z]+){0,2}\s+(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Drive|Dr\.?|Lane|Ln\.?|Boulevard|Blvd\.?|Way|Place|Pl\.?|Court|Ct\.?|Terrace|Terr\.?)\b/i;
  const PO_BOX_RE = /\bP\.?O\.?\s*Box\b/i;
  const poBoxFound = PO_BOX_RE.test(combinedText);
  let addressFound = ADDRESS_RE.test(combinedText);

  // Billing address on file also counts as a verifiable physical address.
  if (!addressFound && shopInfo?.billingAddress?.address1) {
    const ba = shopInfo.billingAddress;
    const hasStreet = ADDRESS_RE.test(ba.address1 ?? "");
    const hasCity = !!(ba.city && ba.country);
    if (hasStreet || hasCity) addressFound = true;
  }

  const methodsFound = [phoneFound, emailFound, addressFound].filter(Boolean)
    .length;
  const passed = methodsFound >= 2;

  const raw_data = {
    contact_pages_checked: contactPages.map((p) => ({
      title: p.title,
      handle: p.handle,
    })),
    billing_address: shopInfo?.billingAddress ?? null,
    phone_found: phoneFound,
    email_found: emailFound,
    store_domain_checked: storeDomain,
    address_found: addressFound,
    po_box_detected: poBoxFound,
    methods_found: methodsFound,
  };

  if (passed) {
    return {
      check_name: CHECK_NAME,
      passed: true,
      severity: "info",
      title: "Contact Information",
      description: `${methodsFound} of 3 contact methods found on public pages.`,
      fix_instruction: "No action required.",
      raw_data,
    };
  }

  const missing: string[] = [];
  if (!phoneFound) missing.push("phone number");
  if (!emailFound) missing.push("store-domain email address");
  if (!addressFound) missing.push("physical street address");

  return {
    check_name: CHECK_NAME,
    passed: false,
    severity: "critical",
    title: "Insufficient Contact Information",
    description:
      `Only ${methodsFound} of 3 required contact methods are publicly visible. ` +
      `Missing: ${missing.join(", ")}.` +
      (poBoxFound
        ? " Note: a PO Box was detected — GMC requires a physical street address."
        : ""),
    fix_instruction:
      "1. Create or update your 'Contact Us' or 'About' page.\n" +
      "2. Add at least 2 of the following: a phone number, an email address " +
      "using your store's domain (e.g. support@yourdomain.com), and a physical " +
      "street address (PO Boxes are not accepted by Google Merchant Center).\n" +
      "3. In Shopify Admin → Online Store → Pages, publish the updated page.",
    raw_data,
  };
}
