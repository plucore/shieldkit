/**
 * CHECK 1 — contact_information
 *
 * Confirms the store exposes AT LEAST ONE reachable, visible contact method.
 * Google's current bar (since Aug 2021) is one form of contact, and it accepts
 * an email, phone, physical address, a contact form/page, OR a social business
 * profile. This check accepts all of those, searched across the store's pages
 * AND the homepage markup (header/footer) AND the Shopify store contact email.
 *
 * Static fetching cannot see JS-rendered contact forms or footers, so detection
 * is biased toward false negatives: if ANY contact signal is present we pass;
 * we only warn when no contact of any kind can be found anywhere fetched.
 */

import type { ShopInfo, Page } from "../shopify-api.server";
import type { CheckResult } from "./types";
import { extractDomain } from "./helpers.server";
import { detectContactSignals, ADDRESS_RE } from "./shared/html-detectors.server";

export function checkContactInformation(
  pages: Page[],
  shopInfo: ShopInfo | null,
  homepageHtml: string | null = null,
): CheckResult {
  const CHECK_NAME = "contact_information";

  // ── HTML-only signals (shared detector) across page bodies + homepage ────
  const html = detectContactSignals([...pages.map((p) => p.body ?? ""), homepageHtml]);

  // ── Phone ────────────────────────────────────────────────────────────────
  const phoneFound = html.phoneFound;

  // ── Email: HTML signal, OR the Shopify store contact email (Admin API) ────
  const emailFound = html.emailFound || !!shopInfo?.contactEmail?.trim();

  // ── Address: HTML signal, OR the store's billing address on file (Admin) ──
  const poBoxFound = html.poBoxFound;
  let addressFound = html.addressFound;
  if (!addressFound && shopInfo?.billingAddress?.address1) {
    const ba = shopInfo.billingAddress;
    const hasStreet = ADDRESS_RE.test(ba.address1 ?? "");
    const hasCity = !!(ba.city && ba.country);
    if (hasStreet || hasCity) addressFound = true;
  }

  // ── Contact form / page: a /contact page exists (Admin) or is linked (HTML) ─
  const hasContactPage = pages.some((p) =>
    /contact/i.test(`${p.title} ${p.handle}`),
  );
  const contactFormFound = hasContactPage || html.contactLinkFound;

  // ── Social business profile ──────────────────────────────────────────────
  const socialFound = html.socialFound;

  // ── Any single signal passes (1-of-N) ────────────────────────────────────
  const methods: string[] = [];
  if (phoneFound) methods.push("phone number");
  if (emailFound) methods.push("email address");
  if (addressFound) methods.push("physical address");
  if (contactFormFound) methods.push("contact page/form");
  if (socialFound) methods.push("social profile");
  const passed = methods.length >= 1;

  const storeDomain = shopInfo
    ? extractDomain(shopInfo.primaryDomain.host)
    : null;

  const raw_data = {
    pages_checked: pages.map((p) => ({ title: p.title, handle: p.handle })),
    homepage_searched: !!homepageHtml,
    store_domain: storeDomain,
    store_contact_email_present: !!shopInfo?.contactEmail?.trim(),
    phone_found: phoneFound,
    email_found: emailFound,
    address_found: addressFound,
    po_box_detected: poBoxFound,
    contact_form_found: contactFormFound,
    social_found: socialFound,
    methods_found: methods,
    methods_count: methods.length,
  };

  if (passed) {
    return {
      check_name: CHECK_NAME,
      passed: true,
      severity: "info",
      title: "Contact Information",
      description: `Contact method${methods.length === 1 ? "" : "s"} detected: ${methods.join(", ")}.`,
      fix_instruction: "No action required.",
      raw_data,
    };
  }

  return {
    check_name: CHECK_NAME,
    passed: false,
    severity: "warning",
    title: "No Contact Method Detected",
    description:
      "No contact method (email, phone, physical address, contact page, or " +
      "social profile) could be found on your storefront. Google Merchant " +
      "Center and shoppers expect at least one visible way to reach you. " +
      "(Note: contact details rendered only by JavaScript can be missed by an " +
      "automated scan — if you already show one, you can disregard this.)",
    fix_instruction:
      "Add at least one contact method — any one of these satisfies Google:\n" +
      "1. Set a public support email in Shopify Admin → Settings → General → " +
      "Store contact details, or add one to your footer/contact page.\n" +
      "2. Add a Contact page (Shopify Admin → Online Store → Pages) — the " +
      "'Contact' page template includes a contact form, which Google accepts.\n" +
      "3. Or link a social business profile (Instagram, Facebook, TikTok, etc.) " +
      "in your footer. A phone number or physical address also qualifies.",
    raw_data,
  };
}
