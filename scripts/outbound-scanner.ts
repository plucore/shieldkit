#!/usr/bin/env tsx
/**
 * scripts/outbound-scanner.ts
 *
 * Standalone GMC compliance scanner for public Shopify storefronts.
 * No OAuth, no app install, no Supabase required.
 *
 * NOTE ON IMPORTS:
 *   The individual check functions in app/lib/compliance-scanner.server.ts are
 *   not exported and the module transitively imports the Shopify Admin SDK and
 *   Supabase client, which cannot initialize outside the Remix server context.
 *   This script therefore contains the same check logic (identical regexes,
 *   same cheerio algorithms, same scoring) as portable inline functions.
 *
 * Checks run:
 *   1  contact_information      — phone / email / address on public pages
 *   3  shipping_policy          — delivery timeline + cost in public policy page
 *   4  privacy_and_terms        — privacy policy + ToS present
 *   6  checkout_transparency    — payment icons on homepage
 *   7  storefront_accessibility — not password-protected, product pages reachable
 *   8  structured_data_json_ld  — Product JSON-LD on sampled product pages
 *   9  page_speed               — Google PageSpeed Insights mobile score
 *
 * Usage:
 *   npx tsx scripts/outbound-scanner.ts https://example.myshopify.com
 *   npm run scan -- https://example.myshopify.com
 *
 * Optional env vars:
 *   GOOGLE_PAGESPEED_API_KEY — increases PSI API quota (unauthenticated tier is limited)
 */

import { load as cheerioLoad } from "cheerio";
import dns from "node:dns/promises";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type Severity = "critical" | "warning" | "info" | "error";

interface CheckResult {
  check_name: string;
  passed: boolean;
  severity: Severity;
  title: string;
  description: string;
  fix_instruction: string;
  raw_data: Record<string, unknown>;
}

interface PageFetchResult {
  url: string;
  status: number | null;
  html: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// URL Validation + SSRF Prevention
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Patterns that match private, loopback, and link-local IP ranges.
 * Checked against every resolved address for the target hostname.
 */
const PRIVATE_IP_PATTERNS: RegExp[] = [
  /^127\./,               // 127.0.0.0/8  — IPv4 loopback
  /^10\./,                // 10.0.0.0/8   — RFC1918 private
  /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12 — RFC1918 private
  /^192\.168\./,          // 192.168.0.0/16 — RFC1918 private
  /^169\.254\./,          // 169.254.0.0/16 — link-local (AWS metadata etc.)
  /^0\.0\.0\.0$/,         // unspecified
  /^::1$/,                // IPv6 loopback
  /^fc[0-9a-f]{2}:/i,     // IPv6 unique local fc00::/7
  /^fd[0-9a-f]{2}:/i,     // IPv6 unique local fd00::/8
];

function isPrivateAddress(ip: string): boolean {
  return PRIVATE_IP_PATTERNS.some((re) => re.test(ip));
}

type UrlValidationResult =
  | { valid: true; url: URL }
  | { valid: false; error: string };

async function validateAndSanitizeUrl(raw: string): Promise<UrlValidationResult> {
  let url: URL;
  try {
    // Prepend scheme if missing so users can type "example.myshopify.com"
    url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
  } catch {
    return { valid: false, error: `Cannot parse as a URL: "${raw}"` };
  }

  if (url.protocol !== "https:") {
    return {
      valid: false,
      error: `URL must use HTTPS. Got "${url.protocol}" — GMC itself requires HTTPS storefronts.`,
    };
  }

  const hostname = url.hostname;

  // Resolve all A/AAAA records and block private ranges (SSRF prevention).
  let addresses: dns.LookupAddress[];
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    return { valid: false, error: `Could not resolve hostname: "${hostname}"` };
  }

  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      return {
        valid: false,
        error:
          `Blocked: "${hostname}" resolves to a private/loopback address (${address}). ` +
          `Only public internet addresses are permitted.`,
      };
    }
  }

  return { valid: true, url };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Fetch Helpers
// ─────────────────────────────────────────────────────────────────────────────

const REQUEST_HEADERS = {
  "User-Agent": "ShieldKit-Compliance-Scanner/1.0 (+https://shieldkit.app)",
  Accept: "text/html,application/xhtml+xml,application/json",
};

async function fetchPage(
  url: string,
  timeoutMs = 10_000
): Promise<{ status: number; html: string } | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: REQUEST_HEADERS,
      redirect: "follow",
    });
    const html = await res.text();
    return { status: res.status, html };
  } catch {
    return null;
  }
}

async function fetchJson<T>(url: string, timeoutMs = 10_000): Promise<T | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { ...REQUEST_HEADERS, Accept: "application/json" },
      redirect: "follow",
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared Utility (identical to compliance-scanner.server.ts)
// ─────────────────────────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s{2,}/g, " ")
    .trim();
}

async function safeCheck(
  checkName: string,
  fn: () => CheckResult | Promise<CheckResult>
): Promise<CheckResult> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      check_name: checkName,
      passed: false,
      severity: "error",
      title: checkName.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      description: "Could not complete this check — an unexpected error occurred.",
      fix_instruction:
        "Re-run the scan. If the problem persists check network connectivity.",
      raw_data: { error: message },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 1 — contact_information
// Same regexes as compliance-scanner.server.ts. shopInfo billing address is
// unavailable without the Admin API so that fallback path is omitted.
// ─────────────────────────────────────────────────────────────────────────────

function checkContactInformation(
  contactHtml: string | null,
  aboutHtml: string | null
): CheckResult {
  const CHECK_NAME = "contact_information";

  const combinedText = [contactHtml, aboutHtml]
    .filter(Boolean)
    .map((h) => stripHtml(h!))
    .join(" ");

  if (!combinedText.trim()) {
    return {
      check_name: CHECK_NAME,
      passed: false,
      severity: "critical",
      title: "Contact Information — Unable to Scan",
      description:
        "Could not fetch any contact or about pages. The store may be password-protected " +
        "or those pages may not exist.",
      fix_instruction:
        "Ensure /pages/contact-us and /pages/about-us are published and publicly accessible.",
      raw_data: { error: "no_pages_fetched" },
    };
  }

  const PHONE_RE =
    /(?:\+?1[-.\s]?)?\(?([2-9]\d{2})\)?[-.\s]([2-9]\d{2})[-.\s](\d{4})|\+[1-9]\d{1,2}[-.\s]\d{3,5}[-.\s]\d{3,5}(?:[-.\s]\d{2,4})?/g;
  const phoneFound = PHONE_RE.test(combinedText);

  const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const emailFound = EMAIL_RE.test(combinedText);

  const ADDRESS_RE =
    /\d+\s+[A-Za-z]+(?:\s+[A-Za-z]+){0,2}\s+(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Drive|Dr\.?|Lane|Ln\.?|Boulevard|Blvd\.?|Way|Place|Pl\.?|Court|Ct\.?|Terrace|Terr\.?)\b/i;
  const PO_BOX_RE = /\bP\.?O\.?\s*Box\b/i;
  const addressFound = ADDRESS_RE.test(combinedText);
  const poBoxFound = PO_BOX_RE.test(combinedText);

  const methodsFound = [phoneFound, emailFound, addressFound].filter(Boolean).length;
  const passed = methodsFound >= 2;

  const raw_data = {
    phone_found: phoneFound,
    email_found: emailFound,
    address_found: addressFound,
    po_box_detected: poBoxFound,
    methods_found: methodsFound,
    pages_scraped: [contactHtml ? "contact" : null, aboutHtml ? "about" : null].filter(Boolean),
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
  if (!emailFound) missing.push("email address");
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
      "Add at least 2 of the following to your Contact or About page: " +
      "a phone number, an email address, or a physical street address (not a PO Box).",
    raw_data,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 3 — shipping_policy
// ─────────────────────────────────────────────────────────────────────────────

function checkShippingPolicy(policyHtml: string | null): CheckResult {
  const CHECK_NAME = "shipping_policy";

  if (!policyHtml || !stripHtml(policyHtml).trim()) {
    return {
      check_name: CHECK_NAME,
      passed: false,
      severity: "critical",
      title: "Missing Shipping Policy",
      description:
        "No Shipping Policy was found at /policies/shipping-policy. " +
        "Google Merchant Center requires a shipping policy with delivery times and costs.",
      fix_instruction:
        "In Shopify Admin → Settings → Policies, create a Shipping Policy. " +
        "Include delivery timeframes (e.g. '3–7 business days') and shipping costs.",
      raw_data: { policy_present: false },
    };
  }

  const text = stripHtml(policyHtml);

  const TIMELINE_RE =
    /\d+\s*(?:to|[-–])\s*\d+\s*(?:business\s+)?days?|\d+\s*(?:business\s+)?days?|within\s+\d+\s*(?:business\s+)?days?|same[\s-]day|next[\s-]day|overnight/i;
  const COST_RE =
    /free\s+shipping|flat[\s-]rate|\$\s*[\d,.]+|calculated\s+at\s+checkout|free\s+on\s+orders|shipping\s+costs?|postage|delivery\s+fee/i;

  const hasTimeline = TIMELINE_RE.test(text);
  const hasCost = COST_RE.test(text);

  const raw_data = {
    policy_present: true,
    body_length: text.length,
    has_delivery_timeline: hasTimeline,
    has_shipping_cost_info: hasCost,
  };

  const issues: string[] = [];
  if (!hasTimeline) issues.push("no delivery timeline (e.g. '3–7 business days')");
  if (!hasCost) issues.push("no shipping cost info (e.g. 'Free shipping' or '$5.99 flat rate')");

  if (issues.length === 0) {
    return {
      check_name: CHECK_NAME,
      passed: true,
      severity: "info",
      title: "Shipping Policy",
      description: "Policy exists and specifies delivery timelines and costs.",
      fix_instruction: "No action required.",
      raw_data,
    };
  }

  return {
    check_name: CHECK_NAME,
    passed: false,
    severity: "warning",
    title: "Vague Shipping Policy",
    description: `Shipping policy exists but is missing: ${issues.join("; ")}.`,
    fix_instruction:
      "Update your Shipping Policy (Shopify Admin → Settings → Policies) to include " +
      "clear delivery timeframes and explicit shipping costs per method.",
    raw_data,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 4 — privacy_and_terms
// ─────────────────────────────────────────────────────────────────────────────

function checkPrivacyAndTerms(
  privacyHtml: string | null,
  termsHtml: string | null
): CheckResult {
  const CHECK_NAME = "privacy_and_terms";

  const privacyPresent = !!(privacyHtml && stripHtml(privacyHtml).trim());
  const termsPresent = !!(termsHtml && stripHtml(termsHtml).trim());

  const raw_data = {
    privacy_policy_present: privacyPresent,
    terms_of_service_present: termsPresent,
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
        ? "Neither a Privacy Policy nor Terms of Service was found. Both are required for GMC approval."
        : "No Privacy Policy was found. This is legally required (GDPR, CCPA) and mandatory for GMC.",
      fix_instruction:
        "In Shopify Admin → Settings → Policies, create both policies using the built-in templates.",
      raw_data,
    };
  }

  return {
    check_name: CHECK_NAME,
    passed: false,
    severity: "warning",
    title: "Missing Terms of Service",
    description:
      "Privacy Policy is present, but no Terms of Service was found. " +
      "ToS is strongly recommended for GMC-listed stores.",
    fix_instruction:
      "In Shopify Admin → Settings → Policies, create a Terms of Service from the template.",
    raw_data,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 6 — checkout_transparency
// ─────────────────────────────────────────────────────────────────────────────

function checkCheckoutTransparency(
  storeUrl: string,
  homepageHtml: string | null
): CheckResult {
  const CHECK_NAME = "checkout_transparency";

  if (!homepageHtml) {
    return {
      check_name: CHECK_NAME,
      passed: false,
      severity: "warning",
      title: "Checkout Transparency — Unable to Scan",
      description: "The public storefront homepage could not be fetched.",
      fix_instruction:
        "Ensure your store is published and not password-protected, then re-run the scan.",
      raw_data: { store_url: storeUrl, error: "homepage_fetch_failed" },
    };
  }

  const $ = cheerioLoad(homepageHtml);

  const PAYMENT_KEYWORDS = [
    "visa", "mastercard", "master-card", "master_card",
    "paypal", "amex", "american-express", "american_express",
    "discover", "apple-pay", "applepay", "apple_pay",
    "google-pay", "googlepay", "gpay", "maestro", "jcb",
    "diners", "shop-pay", "shopify-pay", "shopify_pay",
    "unionpay", "klarna", "afterpay", "clearpay",
  ] as const;

  const foundIcons = new Set<string>();
  const checkText = (text: string) => {
    const lower = text.toLowerCase();
    for (const kw of PAYMENT_KEYWORDS) {
      if (lower.includes(kw)) foundIcons.add(kw);
    }
  };

  $("img").each((_, el) => {
    checkText($(el).attr("src") ?? "");
    checkText($(el).attr("alt") ?? "");
  });
  $("use").each((_, el) => {
    checkText($(el).attr("xlink:href") ?? "");
    checkText($(el).attr("href") ?? "");
  });
  $("[class]").each((_, el) => {
    checkText($(el).attr("class") ?? "");
  });
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
      description: `${found.length} payment method icon(s) detected: ${found.join(", ")}.`,
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
      "No recognisable payment method icons were found on the storefront homepage. " +
      "GMC shoppers expect to see accepted payment methods before checkout.",
    fix_instruction:
      "In Shopify Admin → Online Store → Themes → Theme settings → Footer, enable payment icons. " +
      "Verify your payment providers are active under Settings → Payments.",
    raw_data: { store_url: storeUrl, payment_icons_found: [], icons_count: 0 },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 7 — storefront_accessibility
// ─────────────────────────────────────────────────────────────────────────────

function checkStorefrontAccessibility(
  storeUrl: string,
  productPageResults: PageFetchResult[],
  homepageStatus: number | null,
  homepageHtml: string | null
): CheckResult {
  const CHECK_NAME = "storefront_accessibility";

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
      passwordSignals.push("password form (action=\"/password\") present");
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
        "The store is behind a password page and is not publicly accessible. " +
        "Google Merchant Center cannot crawl or approve password-protected stores.",
      fix_instruction:
        "In Shopify Admin → Online Store → Preferences, uncheck 'Restrict access to visitors with the password'.",
      raw_data: {
        store_url: storeUrl,
        homepage_status: homepageStatus,
        password_protected: true,
        password_signals: passwordSignals,
      },
    };
  }

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
        "In Shopify Admin → Products, verify the affected products are published to the Online Store channel.",
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
        : " No products sampled from /products.json."),
    fix_instruction: "No action required.",
    raw_data,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 8 — structured_data_json_ld
// ─────────────────────────────────────────────────────────────────────────────

function checkStructuredDataJsonLd(productPageResults: PageFetchResult[]): CheckResult {
  const CHECK_NAME = "structured_data_json_ld";

  if (productPageResults.length === 0) {
    return {
      check_name: CHECK_NAME,
      passed: true,
      severity: "info",
      title: "Structured Data (JSON-LD)",
      description: "No product pages were available to scan for structured data.",
      fix_instruction: "No action required.",
      raw_data: { pages_scanned: 0 },
    };
  }

  const REQUIRED_FIELDS = ["name", "image", "description", "offers"] as const;
  const OFFER_REQUIRED = ["price", "priceCurrency", "availability"] as const;

  interface PageReport {
    url: string;
    product_schema_found: boolean;
    missing_required: string[];
  }

  const reports: PageReport[] = [];
  let totalMissingRequired = 0;

  for (const page of productPageResults) {
    if (!page.html) {
      reports.push({
        url: page.url,
        product_schema_found: false,
        missing_required: ["page_fetch_failed"],
      });
      totalMissingRequired++;
      continue;
    }

    const $ = cheerioLoad(page.html);
    let productSchema: Record<string, unknown> | null = null;

    $('script[type="application/ld+json"]').each((_, el) => {
      if (productSchema) return;
      try {
        const raw = JSON.parse($(el).html() ?? "{}") as Record<string, unknown>;
        const candidates: unknown[] = Array.isArray(raw)
          ? raw
          : Array.isArray(raw["@graph"])
          ? (raw["@graph"] as unknown[])
          : [raw];

        for (const node of candidates) {
          if (
            node &&
            typeof node === "object" &&
            !Array.isArray(node) &&
            (node as Record<string, unknown>)["@type"] === "Product"
          ) {
            productSchema = node as Record<string, unknown>;
            break;
          }
        }
      } catch {
        // malformed JSON-LD — treat as missing schema
      }
    });

    if (!productSchema) {
      reports.push({
        url: page.url,
        product_schema_found: false,
        missing_required: [...REQUIRED_FIELDS],
      });
      totalMissingRequired += REQUIRED_FIELDS.length;
      continue;
    }

    const missingRequired: string[] = [];
    for (const field of REQUIRED_FIELDS) {
      if (!productSchema[field]) missingRequired.push(field);
    }

    const offers = productSchema["offers"] as Record<string, unknown> | undefined;
    if (offers) {
      for (const field of OFFER_REQUIRED) {
        if (!offers[field]) missingRequired.push(`offers.${field}`);
      }
    }

    totalMissingRequired += missingRequired.length;
    reports.push({ url: page.url, product_schema_found: true, missing_required: missingRequired });
  }

  const pagesWithNoSchema = reports.filter((r) => !r.product_schema_found).length;
  const raw_data = {
    pages_scanned: productPageResults.length,
    pages_with_schema: reports.filter((r) => r.product_schema_found).length,
    pages_without_schema: pagesWithNoSchema,
    page_reports: reports,
  };

  if (totalMissingRequired === 0) {
    return {
      check_name: CHECK_NAME,
      passed: true,
      severity: "info",
      title: "Structured Data (JSON-LD)",
      description: `Product JSON-LD schema found and validated on all ${productPageResults.length} sampled page(s).`,
      fix_instruction: "No action required.",
      raw_data,
    };
  }

  const allMissing = [...new Set(reports.flatMap((r) => r.missing_required))];

  return {
    check_name: CHECK_NAME,
    passed: false,
    severity: "warning",
    title: "Incomplete or Missing Product JSON-LD Schema",
    description:
      pagesWithNoSchema === productPageResults.length
        ? `No Product JSON-LD schema found on any of the ${productPageResults.length} sampled page(s). ` +
          "Google uses structured data to display products in Shopping results."
        : `JSON-LD schema is missing required fields on ` +
          `${reports.filter((r) => r.missing_required.length > 0).length} of ` +
          `${productPageResults.length} scanned page(s). Missing: ${allMissing.join(", ")}.`,
    fix_instruction:
      "Shopify themes inject Product JSON-LD automatically. " +
      "If missing, check that your theme's product.liquid template has not had structured data removed. " +
      "Required fields: name, image, description, offers (price, priceCurrency, availability). " +
      "Validate with: https://search.google.com/test/rich-results",
    raw_data,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 9 — page_speed
// ─────────────────────────────────────────────────────────────────────────────

async function checkPageSpeed(storeUrl: string): Promise<CheckResult> {
  const CHECK_NAME = "page_speed";

  const apiKey = process.env.GOOGLE_PAGESPEED_API_KEY;
  const apiUrl =
    `https://www.googleapis.com/pagespeedonline/v5/runPagespeed` +
    `?url=${encodeURIComponent(storeUrl)}&strategy=mobile` +
    (apiKey ? `&key=${encodeURIComponent(apiKey)}` : "");

  try {
    const res = await fetch(apiUrl, { signal: AbortSignal.timeout(30_000) });

    if (!res.ok) {
      return {
        check_name: CHECK_NAME,
        passed: true,
        severity: "info",
        title: "Page Speed — API Unavailable",
        description:
          res.status === 429
            ? "PageSpeed Insights API rate-limited this request (HTTP 429). " +
              "Set GOOGLE_PAGESPEED_API_KEY in your environment to increase quota."
            : `PageSpeed Insights API returned HTTP ${res.status}.`,
        fix_instruction: "Set GOOGLE_PAGESPEED_API_KEY to use an authenticated quota tier.",
        raw_data: { store_url: storeUrl, api_status: res.status },
      };
    }

    const psiData = (await res.json()) as {
      lighthouseResult?: {
        categories?: { performance?: { score?: number } };
        audits?: {
          "intrusive-interstitials"?: { score?: number | null; displayValue?: string };
        };
      };
    };

    const rawScore =
      psiData.lighthouseResult?.categories?.performance?.score ?? null;
    const performanceScore = rawScore !== null ? Math.round(rawScore * 100) : null;

    const interstitialsAudit =
      psiData.lighthouseResult?.audits?.["intrusive-interstitials"];
    const interstitialsFailed =
      interstitialsAudit !== undefined && (interstitialsAudit.score ?? 1) < 0.9;

    const raw_data = {
      store_url: storeUrl,
      performance_score: performanceScore,
      intrusive_interstitials_failed: interstitialsFailed,
      intrusive_interstitials_display: interstitialsAudit?.displayValue ?? null,
      authenticated: !!apiKey,
    };

    if (performanceScore === null) {
      return {
        check_name: CHECK_NAME,
        passed: true,
        severity: "info",
        title: "Page Speed — No Score Returned",
        description:
          "Google PageSpeed Insights did not return a performance score for this store.",
        fix_instruction: "Re-scan after the store is fully published.",
        raw_data,
      };
    }

    const issues: string[] = [];
    if (performanceScore < 50) {
      issues.push(`mobile performance score is ${performanceScore}/100 (threshold: 50)`);
    }
    if (interstitialsFailed) {
      issues.push(
        `intrusive interstitials detected (${interstitialsAudit?.displayValue ?? "failed"})`
      );
    }

    if (issues.length === 0) {
      return {
        check_name: CHECK_NAME,
        passed: true,
        severity: "info",
        title: "Page Speed",
        description: `Mobile performance score: ${performanceScore}/100. No intrusive interstitials.`,
        fix_instruction: "No action required.",
        raw_data,
      };
    }

    return {
      check_name: CHECK_NAME,
      passed: false,
      severity: "warning",
      title: "Page Speed Issues Detected",
      description: `PageSpeed Insights flagged the following on mobile: ${issues.join("; ")}.`,
      fix_instruction:
        "Run a full audit at https://pagespeed.web.dev for detailed recommendations. " +
        "Common fixes: compress images (WebP), enable lazy loading, minimise third-party scripts.",
      raw_data,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      check_name: CHECK_NAME,
      passed: true,
      severity: "info",
      title: "Page Speed — Check Skipped",
      description: "PageSpeed Insights could not be reached. Check skipped.",
      fix_instruction:
        "Ensure outbound internet access. Optionally set GOOGLE_PAGESPEED_API_KEY.",
      raw_data: { store_url: storeUrl, error: message },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Report Printer
// ─────────────────────────────────────────────────────────────────────────────

function printReport(storeUrl: string, results: CheckResult[]): void {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed);
  const criticals = failed.filter((r) => r.severity === "critical").length;
  const warnings = failed.filter((r) => r.severity === "warning").length;
  const erroredChecks = results.filter((r) => r.severity === "error").length;

  // Errored checks are excluded from the score denominator (same logic as the server scanner).
  const scorable = results.filter((r) => r.severity !== "error").length;
  const score = scorable > 0 ? Math.round((passed / scorable) * 100) : 0;

  const SEP = "─".repeat(72);
  const ICON = { pass: "✓", critical: "✗", warning: "⚠", info: "·", error: "?" };

  console.log(`\n${SEP}`);
  console.log(`  ShieldKit GMC Public Compliance Scan`);
  console.log(`  Store : ${storeUrl}`);
  console.log(`  Date  : ${new Date().toISOString()}`);
  console.log(SEP);
  console.log(
    `  Score : ${score}%  |  Passed: ${passed}/${results.length}  |  ` +
      `Critical: ${criticals}  |  Warnings: ${warnings}` +
      (erroredChecks > 0 ? `  |  Errors: ${erroredChecks}` : "")
  );
  console.log(SEP);

  for (const r of results) {
    const icon = r.passed
      ? ICON.pass
      : r.severity === "critical"
      ? ICON.critical
      : r.severity === "warning"
      ? ICON.warning
      : r.severity === "error"
      ? ICON.error
      : ICON.info;

    const label = `[${r.severity.toUpperCase()}]`.padEnd(11);
    console.log(`\n  ${icon} ${label} ${r.title}`);
    console.log(`       ${r.description}`);
    if (!r.passed && r.fix_instruction) {
      // Print only the first sentence of the fix instruction to keep the table tidy.
      const shortFix = r.fix_instruction.split("\n")[0];
      console.log(`       Fix: ${shortFix}`);
    }
  }

  console.log(`\n${SEP}`);
  console.log("  Full JSON results:");
  console.log(SEP);
  console.log(
    JSON.stringify(
      {
        store: storeUrl,
        scanned_at: new Date().toISOString(),
        score,
        summary: {
          total_checks: results.length,
          passed_checks: passed,
          critical_count: criticals,
          warning_count: warnings,
          errored_checks: erroredChecks,
        },
        results,
      },
      null,
      2
    )
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const rawUrl = process.argv[2];

  if (!rawUrl) {
    console.error(
      "\nUsage: npx tsx scripts/outbound-scanner.ts <shopify-store-url>\n" +
        "  e.g. npx tsx scripts/outbound-scanner.ts https://example.myshopify.com\n" +
        "       npm run scan -- https://example.myshopify.com\n"
    );
    process.exit(1);
  }

  // ── 1. Validate URL (blocks non-HTTPS and SSRF targets) ───────────────────
  process.stdout.write(`\nValidating URL "${rawUrl}"... `);
  const validation = await validateAndSanitizeUrl(rawUrl);
  if (!validation.valid) {
    console.error(`\n\nError: ${validation.error}\n`);
    process.exit(1);
  }
  const storeUrl = validation.url.origin; // strip trailing path/query
  console.log(`OK → ${storeUrl}`);

  // ── 2. Fetch all public data concurrently ─────────────────────────────────
  console.log("Fetching public storefront pages...");

  // Try common Shopify page handle variants for contact + about.
  const [
    homepageFetch,
    contactFetch,
    aboutFetch,
    shippingFetch,
    privacyFetch,
    termsFetch,
    productsJson,
  ] = await Promise.all([
    fetchPage(`${storeUrl}/`),
    // Try /pages/contact-us first, fall back to /pages/contact
    fetchPage(`${storeUrl}/pages/contact-us`).then(
      (r) => (r && r.status === 200 ? r : fetchPage(`${storeUrl}/pages/contact`))
    ),
    // Try /pages/about-us first, fall back to /pages/about
    fetchPage(`${storeUrl}/pages/about-us`).then(
      (r) => (r && r.status === 200 ? r : fetchPage(`${storeUrl}/pages/about`))
    ),
    fetchPage(`${storeUrl}/policies/shipping-policy`),
    fetchPage(`${storeUrl}/policies/privacy-policy`),
    fetchPage(`${storeUrl}/policies/terms-of-service`),
    fetchJson<{ products: Array<{ handle: string }> }>(
      `${storeUrl}/products.json?limit=5`
    ),
  ]);

  // Sample up to 3 product pages for checks 7 (reachability) and 8 (JSON-LD).
  const productHandles = (productsJson?.products ?? []).slice(0, 3).map((p) => p.handle);
  const productPageUrls = productHandles.map((h) => `${storeUrl}/products/${h}`);
  const rawProductFetches = await Promise.all(productPageUrls.map((u) => fetchPage(u)));

  const productPageResults: PageFetchResult[] = productPageUrls.map((url, i) => ({
    url,
    status: rawProductFetches[i]?.status ?? null,
    html: rawProductFetches[i]?.html ?? null,
  }));

  console.log(
    `Data fetched — homepage: HTTP ${homepageFetch?.status ?? "failed"}, ` +
      `products sampled: ${productPageUrls.length}\n`
  );

  // ── 3. Run all 7 checks concurrently ──────────────────────────────────────
  console.log("Running compliance checks...");

  const results = await Promise.all([
    safeCheck("contact_information", () =>
      checkContactInformation(
        contactFetch?.status === 200 ? (contactFetch.html ?? null) : null,
        aboutFetch?.status === 200 ? (aboutFetch.html ?? null) : null
      )
    ),
    safeCheck("shipping_policy", () =>
      checkShippingPolicy(
        shippingFetch?.status === 200 ? (shippingFetch.html ?? null) : null
      )
    ),
    safeCheck("privacy_and_terms", () =>
      checkPrivacyAndTerms(
        privacyFetch?.status === 200 ? (privacyFetch.html ?? null) : null,
        termsFetch?.status === 200 ? (termsFetch.html ?? null) : null
      )
    ),
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
  ]);

  printReport(storeUrl, results);
}

main().catch((err) => {
  console.error("\nFatal error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
