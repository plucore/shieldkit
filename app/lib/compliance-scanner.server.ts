/**
 * app/lib/compliance-scanner.server.ts
 *
 * The ShieldKit GMC compliance scanner engine.
 *
 * Entry point: runComplianceScan(merchantId, shopifyDomain, scanType?)
 *
 * Architecture:
 *   1. Fetch all required data concurrently via the shopify-api service layer.
 *   2. Run 5 independent compliance checks, each as a typed helper function.
 *   3. Aggregate results, calculate the compliance score.
 *   4. Persist the scan record and all violation rows to Supabase.
 *   5. Return the full scan + violations to the caller.
 */

import { load as cheerioLoad } from "cheerio";
import {
  createAdminClient,
  getShopInfo,
  getShopPolicies,
  getProducts,
  getPages,
  type ShopInfo,
  type ShopPoliciesResult,
  type Product,
  type Page,
} from "./shopify-api.server";
import { supabase } from "../supabase.server";

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export type Severity = "critical" | "warning" | "info" | "error";

/** The shape returned by every internal check helper. */
interface CheckResult {
  check_name: string;
  passed: boolean;
  severity: Severity;
  title: string;
  description: string;
  fix_instruction: string;
  raw_data: Record<string, unknown>;
}

/** A fully persisted violation row as returned from Supabase. */
export interface ScanViolation {
  id: string;
  scan_id: string;
  check_name: string;
  passed: boolean;
  severity: Severity;
  title: string;
  description: string | null;
  fix_instruction: string | null;
  raw_data: Record<string, unknown> | null;
  created_at: string;
}

/** A fully persisted scan row as returned from Supabase. */
export interface ScanRecord {
  id: string;
  merchant_id: string;
  scan_type: "manual" | "automated";
  compliance_score: number;
  total_checks: number;
  passed_checks: number;
  critical_count: number;
  warning_count: number;
  info_count: number;
  created_at: string;
}

/** The value returned to callers of runComplianceScan(). */
export interface ComplianceScanResult {
  scan: ScanRecord;
  violations: ScanViolation[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Strips all HTML tags from a string and collapses whitespace. */
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

/** Extracts the registrable domain from a hostname (e.g. "store.com" from "www.store.com"). */
function extractDomain(host: string): string {
  const parts = host.replace(/^https?:\/\//, "").split(".");
  if (parts.length >= 2) return parts.slice(-2).join(".");
  return host;
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 1 — contact_information
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scans contact/about pages and the store billing address for three contact
 * methods: phone number, store-domain email, and physical street address.
 * The store must have at least 2 of the 3 publicly visible.
 */
function checkContactInformation(
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

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 2 — refund_return_policy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verifies the refund policy exists and contains the three required specifics:
 * a return window, item condition requirements, and the accepted refund method.
 * Also flags placeholder text that indicates the policy was not customised.
 */
function checkRefundPolicy(policies: ShopPoliciesResult): CheckResult {
  const CHECK_NAME = "refund_return_policy";
  const policy = policies.REFUND_POLICY;

  if (!policy || !policy.body?.trim()) {
    return {
      check_name: CHECK_NAME,
      passed: false,
      severity: "critical",
      title: "Missing Refund & Return Policy",
      description:
        "No Refund/Return Policy was found. Google Merchant Center requires " +
        "a clearly visible and detailed return policy for all Shopping listings.",
      fix_instruction:
        "1. In Shopify Admin → Settings → Policies, create a Refund Policy.\n" +
        "2. Specify: the return window (e.g. '30 days'), the required item " +
        "condition (e.g. 'unused, in original packaging'), and the refund " +
        "method (e.g. 'full refund', 'store credit', or 'exchange').\n" +
        "3. Save and ensure the policy page is linked in your store footer.",
      raw_data: { policy_present: false },
    };
  }

  const text = stripHtml(policy.body);
  const bodyLength = text.length;

  // ── Content quality signals ───────────────────────────────────────────────
  const RETURN_WINDOW_RE =
    /\d+\s*(?:calendar\s+)?(?:day|week|month|year)s?(?:\s*[-–]\s*\d+\s*(?:day|week|month|year)s?)?/i;
  const ITEM_CONDITION_RE =
    /\b(?:unused|unworn|unwashed|original\s+packaging|original\s+condition|undamaged|unopened|tags\s+attached)\b/i;
  const REFUND_METHOD_RE =
    /\b(?:full\s+refund|refund|exchange|store\s+credit|replacement|credit\s+card)\b/i;
  const PLACEHOLDER_RE =
    /lorem\s+ipsum|\[your\s+(?:company|store|name)\]|\[company\s*name\]|\[insert\b/i;

  const hasReturnWindow = RETURN_WINDOW_RE.test(text);
  const hasItemCondition = ITEM_CONDITION_RE.test(text);
  const hasRefundMethod = REFUND_METHOD_RE.test(text);
  const hasPlaceholder = PLACEHOLDER_RE.test(text);

  const raw_data = {
    policy_present: true,
    policy_url: policy.url,
    body_length: bodyLength,
    has_return_window: hasReturnWindow,
    has_item_condition: hasItemCondition,
    has_refund_method: hasRefundMethod,
    has_placeholder_text: hasPlaceholder,
  };

  const issues: string[] = [];
  if (hasPlaceholder)
    issues.push("contains placeholder/template text that must be replaced");
  if (!hasReturnWindow) issues.push("no return window specified (e.g. '30 days')");
  if (!hasItemCondition)
    issues.push("no item condition requirement (e.g. 'unused, original packaging')");
  if (!hasRefundMethod)
    issues.push("no refund method specified (e.g. 'full refund', 'store credit')");

  if (issues.length === 0) {
    return {
      check_name: CHECK_NAME,
      passed: true,
      severity: "info",
      title: "Refund & Return Policy",
      description: "Policy exists and contains all required specifics.",
      fix_instruction: "No action required.",
      raw_data,
    };
  }

  return {
    check_name: CHECK_NAME,
    passed: false,
    severity: "warning",
    title: "Incomplete Refund & Return Policy",
    description:
      `Refund policy exists but is missing key details: ${issues.join("; ")}.`,
    fix_instruction:
      "Update your Refund Policy (Shopify Admin → Settings → Policies) to:\n" +
      "1. State the return window clearly (e.g. 'Returns accepted within 30 days of delivery').\n" +
      "2. Specify required item condition (e.g. 'Items must be unused and in original packaging').\n" +
      "3. Describe the refund method (e.g. 'Refunds issued to original payment method within 5 business days').\n" +
      "4. Remove any placeholder text such as '[your company name]' or 'Lorem ipsum'.",
    raw_data,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 3 — shipping_policy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verifies the shipping policy exists and contains delivery timeline and
 * shipping cost information — both required by Google Merchant Center.
 */
function checkShippingPolicy(policies: ShopPoliciesResult): CheckResult {
  const CHECK_NAME = "shipping_policy";
  const policy = policies.SHIPPING_POLICY;

  if (!policy || !policy.body?.trim()) {
    return {
      check_name: CHECK_NAME,
      passed: false,
      severity: "critical",
      title: "Missing Shipping Policy",
      description:
        "No Shipping Policy was found. Google Merchant Center requires a " +
        "shipping policy that details delivery times and costs for all regions " +
        "where products are sold.",
      fix_instruction:
        "1. In Shopify Admin → Settings → Policies, create a Shipping Policy.\n" +
        "2. Include: estimated delivery timeframes (e.g. '3–7 business days'), " +
        "and shipping costs (e.g. 'Free shipping on orders over $50, otherwise $5.99 flat rate').\n" +
        "3. If you ship internationally, add per-region information.\n" +
        "4. Link the policy in your store footer.",
      raw_data: { policy_present: false },
    };
  }

  const text = stripHtml(policy.body);
  const bodyLength = text.length;

  // ── Content quality signals ───────────────────────────────────────────────
  const TIMELINE_RE =
    /\d+\s*(?:to|[-–])\s*\d+\s*(?:business\s+)?days?|\d+\s*(?:business\s+)?days?|within\s+\d+\s*(?:business\s+)?days?|same[\s-]day|next[\s-]day|overnight/i;
  const COST_RE =
    /free\s+shipping|flat[\s-]rate|\$\s*[\d,.]+|calculated\s+at\s+checkout|free\s+on\s+orders|shipping\s+costs?|postage|delivery\s+fee/i;

  const hasTimeline = TIMELINE_RE.test(text);
  const hasCost = COST_RE.test(text);

  const raw_data = {
    policy_present: true,
    policy_url: policy.url,
    body_length: bodyLength,
    has_delivery_timeline: hasTimeline,
    has_shipping_cost_info: hasCost,
  };

  const issues: string[] = [];
  if (!hasTimeline)
    issues.push(
      "no delivery timeline mentioned (e.g. '3–7 business days')"
    );
  if (!hasCost)
    issues.push(
      "no shipping cost information (e.g. 'Free shipping', '$5.99 flat rate', or 'calculated at checkout')"
    );

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
    description:
      `Shipping policy exists but is missing important details: ${issues.join("; ")}.`,
    fix_instruction:
      "Update your Shipping Policy (Shopify Admin → Settings → Policies):\n" +
      "1. Add a clear delivery timeframe per shipping method " +
      "(e.g. 'Standard Shipping: 5–7 business days').\n" +
      "2. State your shipping costs explicitly — even if free " +
      "(e.g. 'Free standard shipping on all orders').\n" +
      "3. For international shipping, list each region's estimated transit times.",
    raw_data,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 4 — privacy_and_terms
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Checks for the presence of a Privacy Policy (critical if absent — legally
 * required in most jurisdictions and by GMC) and Terms of Service (warning
 * if absent). Both must be present for the check to pass.
 */
function checkPrivacyAndTerms(policies: ShopPoliciesResult): CheckResult {
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

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 5 — product_data_quality
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evaluates product listing quality across four dimensions required by GMC:
 * description length, images, pricing, and SKU/identifier data.
 * Severity scales with the percentage of flagged products.
 */
function checkProductDataQuality(products: Product[]): CheckResult {
  const CHECK_NAME = "product_data_quality";

  if (products.length === 0) {
    return {
      check_name: CHECK_NAME,
      passed: true,
      severity: "info",
      title: "Product Data Quality",
      description: "No products found to evaluate.",
      fix_instruction: "No action required.",
      raw_data: { total_products: 0, flagged_count: 0, flagged_products: [] },
    };
  }

  type ProductIssue =
    | "empty_description"
    | "short_description"
    | "no_images"
    | "zero_price"
    | "missing_sku";

  interface FlaggedProduct {
    title: string;
    handle: string;
    issues: ProductIssue[];
  }

  const flagged: FlaggedProduct[] = [];

  for (const product of products) {
    const issues: ProductIssue[] = [];

    // Description quality
    const descText = stripHtml(product.descriptionHtml ?? "");
    if (!descText) {
      issues.push("empty_description");
    } else if (descText.length < 100) {
      issues.push("short_description");
    }

    // Image presence
    if (!product.images || product.images.length === 0) {
      issues.push("no_images");
    }

    // Pricing — flag any variant with a zero or missing price
    const hasZeroOrNullPrice = product.variants.some(
      (v) => !v.price || v.price === "0.00"
    );
    if (hasZeroOrNullPrice) {
      issues.push("zero_price");
    }

    // SKU — flag if ALL variants have no SKU (GMC uses SKU as an identifier)
    const allVariantsNoSku =
      product.variants.length > 0 &&
      product.variants.every((v) => !v.sku || v.sku.trim() === "");
    if (allVariantsNoSku) {
      issues.push("missing_sku");
    }

    if (issues.length > 0) {
      flagged.push({ title: product.title, handle: product.handle, issues });
    }
  }

  const totalProducts = products.length;
  const flaggedCount = flagged.length;
  const flaggedPct = (flaggedCount / totalProducts) * 100;

  const raw_data = {
    total_products: totalProducts,
    flagged_count: flaggedCount,
    flagged_percentage: Math.round(flaggedPct * 10) / 10,
    // Cap sample at 15 products to keep the JSONB payload reasonable.
    flagged_products: flagged.slice(0, 15),
  };

  if (flaggedCount === 0) {
    return {
      check_name: CHECK_NAME,
      passed: true,
      severity: "info",
      title: "Product Data Quality",
      description: `All ${totalProducts} products pass data quality checks.`,
      fix_instruction: "No action required.",
      raw_data,
    };
  }

  const severity: Severity = flaggedPct > 20 ? "warning" : "info";

  // Build a human-readable summary of what issue types were found.
  const issueTypeCounts: Partial<Record<ProductIssue, number>> = {};
  for (const fp of flagged) {
    for (const issue of fp.issues) {
      issueTypeCounts[issue] = (issueTypeCounts[issue] ?? 0) + 1;
    }
  }
  const issueSummary = (
    Object.entries(issueTypeCounts) as [ProductIssue, number][]
  )
    .map(([issue, count]) => {
      const label: Record<ProductIssue, string> = {
        empty_description: "empty description",
        short_description: "description under 100 characters",
        no_images: "no product images",
        zero_price: "zero or missing price",
        missing_sku: "all variants missing SKU",
      };
      return `${count} with ${label[issue]}`;
    })
    .join(", ");

  return {
    check_name: CHECK_NAME,
    passed: false,
    severity,
    title: "Product Data Quality Issues",
    description:
      `${flaggedCount} of ${totalProducts} products (${flaggedPct.toFixed(1)}%) ` +
      `have data quality issues: ${issueSummary}.`,
    fix_instruction:
      "For each flagged product in Shopify Admin → Products:\n" +
      "1. Empty/short description: Write at least 100 characters describing " +
      "the product's features, materials, dimensions, and use case.\n" +
      "2. No images: Upload at least one high-quality product image " +
      "(minimum 800×800px, white or clean background recommended by GMC).\n" +
      "3. Zero/missing price: Set a valid selling price on each variant. " +
      "Free products should be listed as $0.00 intentionally, but verify this.\n" +
      "4. Missing SKU: Add a unique SKU to each variant. GMC uses SKUs as " +
      "item identifiers — duplicates or blanks cause feed rejections.",
    raw_data,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared fetch utility (used by checks 6, 7, 8)
// ─────────────────────────────────────────────────────────────────────────────

/** Holds the result of a single public HTTP page fetch. */
interface PageFetchResult {
  url: string;
  status: number | null;
  html: string | null;
}

/**
 * Fetches a public URL with a configurable timeout.
 * Returns null on network failure or timeout; never throws.
 */
async function fetchPublicPage(
  url: string,
  timeoutMs = 10_000
): Promise<{ status: number; html: string } | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "User-Agent": "ShieldKit-Compliance-Scanner/1.0 (+https://shieldkit.app)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });
    const html = await res.text();
    return { status: res.status, html };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 6 — checkout_transparency
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scans the public storefront homepage for payment method icons.
 * GMC buyers expect to see accepted payment methods displayed before checkout.
 * Detects icons via <img> src/alt, SVG <use> href, and CSS class names.
 */
async function checkCheckoutTransparency(
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

  // Payment method keywords to detect anywhere in src, alt, class, href, or aria-label.
  const PAYMENT_KEYWORDS = [
    "visa",
    "mastercard",
    "master-card",
    "master_card",
    "paypal",
    "amex",
    "american-express",
    "american_express",
    "discover",
    "apple-pay",
    "applepay",
    "apple_pay",
    "google-pay",
    "googlepay",
    "gpay",
    "maestro",
    "jcb",
    "diners",
    "shop-pay",
    "shopify-pay",
    "shopify_pay",
    "unionpay",
    "klarna",
    "afterpay",
    "clearpay",
  ] as const;

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

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 7 — storefront_accessibility
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verifies the storefront is publicly accessible (not password-protected) and
 * that sampled product pages respond with HTTP 200.
 */
async function checkStorefrontAccessibility(
  storeUrl: string,
  productPageResults: PageFetchResult[],
  homepageStatus: number | null,
  homepageHtml: string | null
): Promise<CheckResult> {
  const CHECK_NAME = "storefront_accessibility";

  // ── Password-protection detection ─────────────────────────────────────────
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
      passwordSignals.push('password form (action="/password") present');
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
        "Your store is behind a password page and is not publicly accessible. " +
        "Google Merchant Center cannot crawl or approve products from password-protected stores.",
      fix_instruction:
        "1. In Shopify Admin → Online Store → Preferences, scroll to 'Password protection'.\n" +
        "2. Uncheck 'Restrict access to visitors with the password' and save.\n" +
        "3. Ensure your store is on an active paid Shopify plan — free trial stores " +
        "are password-protected by default.",
      raw_data: {
        store_url: storeUrl,
        homepage_status: homepageStatus,
        password_protected: true,
        password_signals: passwordSignals,
        product_checks: productPageResults.map((r) => ({ url: r.url, status: r.status })),
      },
    };
  }

  // ── Product page reachability ──────────────────────────────────────────────
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
        "1. In Shopify Admin → Products, verify the affected products are published " +
        "to the Online Store sales channel.\n" +
        "2. If a product handle has changed, update any feeds pointing to the old URL.\n" +
        "3. Check that the product is not archived (Products → filter by 'Archived').",
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
        : " No products with public URLs were available to sample."),
    fix_instruction: "No action required.",
    raw_data,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 8 — structured_data_json_ld
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates Product JSON-LD structured data on up to 3 product pages.
 * Required fields: name, image, description, offers (price, priceCurrency, availability).
 * Recommended fields: sku, itemCondition.
 */
async function checkStructuredDataJsonLd(
  productPageResults: PageFetchResult[]
): Promise<CheckResult> {
  const CHECK_NAME = "structured_data_json_ld";

  if (productPageResults.length === 0) {
    return {
      check_name: CHECK_NAME,
      passed: true,
      severity: "info",
      title: "Structured Data (JSON-LD)",
      description: "No product pages with public URLs were available to scan for structured data.",
      fix_instruction: "No action required.",
      raw_data: { pages_scanned: 0 },
    };
  }

  const REQUIRED_FIELDS = ["name", "image", "description", "offers"] as const;
  const OFFER_REQUIRED = ["price", "priceCurrency", "availability"] as const;
  const RECOMMENDED_FIELDS = ["sku", "itemCondition"] as const;

  interface PageReport {
    url: string;
    product_schema_found: boolean;
    missing_required: string[];
    missing_recommended: string[];
  }

  const reports: PageReport[] = [];
  let totalMissingRequired = 0;

  for (const page of productPageResults) {
    if (!page.html) {
      reports.push({
        url: page.url,
        product_schema_found: false,
        missing_required: ["page_fetch_failed"],
        missing_recommended: [],
      });
      totalMissingRequired++;
      continue;
    }

    const $ = cheerioLoad(page.html);
    let productSchema: Record<string, unknown> | null = null;

    // Scan all <script type="application/ld+json"> blocks
    $('script[type="application/ld+json"]').each((_, el) => {
      if (productSchema) return;
      try {
        const raw = JSON.parse($(el).html() ?? "{}") as Record<string, unknown>;
        // Handle a single object, an array, or a @graph array
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
        // Malformed JSON-LD — count as missing schema
      }
    });

    if (!productSchema) {
      reports.push({
        url: page.url,
        product_schema_found: false,
        missing_required: [...REQUIRED_FIELDS],
        missing_recommended: [...RECOMMENDED_FIELDS],
      });
      totalMissingRequired += REQUIRED_FIELDS.length;
      continue;
    }

    const missingRequired: string[] = [];
    for (const field of REQUIRED_FIELDS) {
      if (!productSchema[field]) missingRequired.push(field);
    }

    // Validate the nested offers object
    const offers = productSchema["offers"] as Record<string, unknown> | undefined;
    if (offers) {
      for (const field of OFFER_REQUIRED) {
        if (!offers[field]) missingRequired.push(`offers.${field}`);
      }
    }

    const missingRecommended: string[] = [];
    for (const field of RECOMMENDED_FIELDS) {
      if (!productSchema[field]) missingRecommended.push(field);
    }

    totalMissingRequired += missingRequired.length;
    reports.push({
      url: page.url,
      product_schema_found: true,
      missing_required: missingRequired,
      missing_recommended: missingRecommended,
    });
  }

  const pagesWithNoSchema = reports.filter((r) => !r.product_schema_found).length;
  const raw_data = {
    pages_scanned: productPageResults.length,
    pages_with_product_schema: reports.filter((r) => r.product_schema_found).length,
    pages_without_schema: pagesWithNoSchema,
    page_reports: reports,
  };

  if (totalMissingRequired === 0) {
    return {
      check_name: CHECK_NAME,
      passed: true,
      severity: "info",
      title: "Structured Data (JSON-LD)",
      description: `Product JSON-LD schema found and validated on all ${productPageResults.length} sampled product page(s).`,
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
        ? `No Product JSON-LD schema found on any of the ${productPageResults.length} sampled product page(s). ` +
          "Google uses structured data to understand and display products in Shopping results."
        : `Product JSON-LD schema is missing required fields on ` +
          `${reports.filter((r) => r.missing_required.length > 0).length} of ` +
          `${productPageResults.length} scanned page(s). Missing: ${allMissing.join(", ")}.`,
    fix_instruction:
      "1. Shopify's default themes inject Product JSON-LD automatically. If missing, " +
      "check that your theme's product.liquid template has not had structured data removed.\n" +
      "2. Required schema fields: name, image, description, and offers " +
      "(containing price, priceCurrency, availability).\n" +
      "3. Recommended additions: sku and itemCondition improve feed quality in GMC.\n" +
      "4. Validate with Google's Rich Results Test: https://search.google.com/test/rich-results",
    raw_data,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 9 — page_speed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calls the Google PageSpeed Insights API to measure mobile performance.
 * Uses GOOGLE_PAGESPEED_API_KEY if set; falls back to the unauthenticated tier.
 * Skips gracefully (info pass) if the API cannot be reached.
 */
async function checkPageSpeed(storeUrl: string): Promise<CheckResult> {
  const CHECK_NAME = "page_speed";

  const apiKey = process.env.GOOGLE_PAGESPEED_API_KEY;
  const apiUrl =
    `https://www.googleapis.com/pagespeedonline/v5/runPagespeed` +
    `?url=${encodeURIComponent(storeUrl)}&strategy=mobile` +
    (apiKey ? `&key=${encodeURIComponent(apiKey)}` : "");

  try {
    const res = await fetch(apiUrl, {
      signal: AbortSignal.timeout(30_000), // PSI can be slow on first call
    });

    if (!res.ok) {
      // Log a specific message for 429 (quota exhausted) so it's easy to spot in logs.
      console.warn(
        res.status === 429
          ? `[Scanner] PageSpeed API throttled (HTTP 429) — defaulting performance score to 50`
          : `[Scanner] PageSpeed API returned HTTP ${res.status} — defaulting performance score to 50`
      );
      // Return a neutral result with score 50 (at the passing threshold) so the
      // overall scan is never blocked by transient API quota or availability issues.
      return {
        check_name: CHECK_NAME,
        passed: true,
        severity: "info",
        title: "Page Speed — API Unavailable",
        description:
          res.status === 429
            ? "PageSpeed Insights API rate-limited this request (HTTP 429). Performance score defaulted to 50/100 so the scan could complete."
            : `PageSpeed Insights API returned HTTP ${res.status}. Performance score defaulted to 50/100 so the scan could complete.`,
        fix_instruction:
          "Set GOOGLE_PAGESPEED_API_KEY in your environment to increase quota and avoid throttling.",
        raw_data: { store_url: storeUrl, api_status: res.status, performance_score: 50, skipped: false },
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

    const rawScore = psiData.lighthouseResult?.categories?.performance?.score ?? null;
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
        fix_instruction:
          "This can occur for brand-new or private-domain stores. Run the scan again after publishing.",
        raw_data,
      };
    }

    const issues: string[] = [];
    if (performanceScore < 50)
      issues.push(`mobile performance score is ${performanceScore}/100 (threshold: 50)`);
    if (interstitialsFailed)
      issues.push(
        `intrusive interstitials detected (${interstitialsAudit?.displayValue ?? "failed"})`
      );

    if (issues.length === 0) {
      return {
        check_name: CHECK_NAME,
        passed: true,
        severity: "info",
        title: "Page Speed",
        description: `Mobile performance score: ${performanceScore}/100. No intrusive interstitials detected.`,
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
        "1. Run a full audit at https://pagespeed.web.dev for detailed recommendations.\n" +
        "2. Common mobile improvements: compress images (WebP format), enable lazy loading, " +
        "minify CSS/JS, and reduce third-party scripts.\n" +
        "3. For intrusive interstitials: remove or delay full-screen pop-ups that appear " +
        "immediately on page load — Google penalises these in Shopping rankings.\n" +
        "4. In Shopify Admin → Apps, disable non-essential apps that inject scripts at load " +
        "time (chat widgets, loyalty pop-ups, etc.).",
      raw_data,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[Scanner] PageSpeed check failed: ${message}`);
    return {
      check_name: CHECK_NAME,
      passed: true,
      severity: "info",
      title: "Page Speed — Check Skipped",
      description:
        "PageSpeed Insights could not be reached. This check was skipped to avoid blocking the scan.",
      fix_instruction:
        "Ensure the server has outbound internet access and a valid GOOGLE_PAGESPEED_API_KEY is set.",
      raw_data: { store_url: storeUrl, error: message, skipped: true },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 10 — business_identity_consistency
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compares the store display name against its primary domain and About/Contact
 * page content using Jaccard word-set overlap. A score below 0.3 suggests a
 * potential branding mismatch that may flag GMC manual reviews.
 */
function checkBusinessIdentityConsistency(
  shopInfo: ShopInfo | null,
  pages: Page[],
  storeUrl: string
): CheckResult {
  const CHECK_NAME = "business_identity_consistency";

  if (!shopInfo) {
    return {
      check_name: CHECK_NAME,
      passed: true,
      severity: "info",
      title: "Business Identity Consistency — Skipped",
      description: "Shop info was unavailable. This check was skipped.",
      fix_instruction: "No action required.",
      raw_data: { skipped: true, reason: "shop_info_unavailable" },
    };
  }

  // ── Normalise text into a bag of meaningful words ──────────────────────────
  const STOP_WORDS = new Set([
    "the", "a", "an", "and", "or", "of", "in", "on", "at", "to", "for",
    "by", "with", "my", "your", "our", "this", "it", "is", "are", "be",
    // Business suffixes that carry no brand identity signal
    "inc", "llc", "ltd", "co", "corp", "shop", "store", "online", "official",
    "brand", "brands", "boutique", "company", "group",
  ]);

  const tokenize = (text: string): Set<string> => {
    const tokens = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
    return new Set(tokens);
  };

  const jaccard = (a: Set<string>, b: Set<string>): number => {
    if (a.size === 0 && b.size === 0) return 1;
    const intersection = new Set([...a].filter((x) => b.has(x)));
    const union = new Set([...a, ...b]);
    return union.size === 0 ? 1 : intersection.size / union.size;
  };

  // ── Build token sets ───────────────────────────────────────────────────────
  const shopNameTokens = tokenize(shopInfo.name);

  // Strip TLD and www, split on hyphens/underscores
  const domainRoot = shopInfo.primaryDomain.host
    .replace(/^www\./, "")
    .split(".")[0]
    .replace(/[-_]/g, " ");
  const domainTokens = tokenize(domainRoot);

  // Use About/Contact page bodies as corroborating identity evidence
  const aboutPages = pages.filter((p) =>
    /about|contact/i.test(p.title + " " + p.handle)
  );
  const aboutText = aboutPages.map((p) => stripHtml(p.body ?? "")).join(" ");
  const aboutTokens = tokenize(aboutText.slice(0, 2_000)); // cap for perf

  // ── Score: weight domain match (60%) + about page match (40%) ─────────────
  const nameVsDomain = jaccard(shopNameTokens, domainTokens);
  const nameVsAbout = aboutTokens.size > 0 ? jaccard(shopNameTokens, aboutTokens) : null;

  const consistencyScore =
    nameVsAbout !== null
      ? nameVsDomain * 0.6 + nameVsAbout * 0.4
      : nameVsDomain;

  const THRESHOLD = 0.3;
  // If the shop name has no meaningful tokens (purely stop words / symbols), skip
  const passed = consistencyScore >= THRESHOLD || shopNameTokens.size === 0;

  const raw_data = {
    shop_name: shopInfo.name,
    primary_domain: shopInfo.primaryDomain.host,
    shop_name_tokens: [...shopNameTokens],
    domain_tokens: [...domainTokens],
    about_page_tokens_sample: [...aboutTokens].slice(0, 20),
    name_vs_domain_score: Math.round(nameVsDomain * 100) / 100,
    name_vs_about_score: nameVsAbout !== null ? Math.round(nameVsAbout * 100) / 100 : null,
    consistency_score: Math.round(consistencyScore * 100) / 100,
    threshold: THRESHOLD,
    store_url: storeUrl,
  };

  if (passed) {
    return {
      check_name: CHECK_NAME,
      passed: true,
      severity: "info",
      title: "Business Identity Consistency",
      description:
        `Store name "${shopInfo.name}" is consistent with the primary domain ` +
        `(consistency score: ${(consistencyScore * 100).toFixed(0)}%).`,
      fix_instruction: "No action required.",
      raw_data,
    };
  }

  return {
    check_name: CHECK_NAME,
    passed: false,
    severity: "info",
    title: "Potential Business Identity Mismatch",
    description:
      `The store name "${shopInfo.name}" has a low word-overlap score with the ` +
      `primary domain "${shopInfo.primaryDomain.host}" ` +
      `(consistency: ${(consistencyScore * 100).toFixed(0)}%). ` +
      "This may indicate a branding inconsistency that could prompt GMC manual review.",
    fix_instruction:
      "1. Ensure your Shopify store name (Settings → General) matches the brand name " +
      "used on your domain, About page, and social profiles.\n" +
      "2. If you have recently rebranded, update your primary domain in Shopify to match.\n" +
      "3. Note: this check uses word overlap and may produce false positives for stores " +
      "with stylised or abbreviated brand names — manual review is advised.",
    raw_data,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export: runComplianceScan
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Executes a single check function and catches any unexpected thrown errors.
 *
 * If the check throws (e.g. a network timeout or uncaught exception), this
 * returns a well-formed CheckResult with severity "error" instead of
 * propagating the error up and aborting the entire scan.
 *
 * Normal check failures (policy missing, score too low, etc.) are returned
 * as CheckResult objects with passed=false — they never throw, so this only
 * fires for genuinely unexpected runtime errors.
 */
async function safeCheck(
  checkName: string,
  fn: () => CheckResult | Promise<CheckResult>
): Promise<CheckResult> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Scanner] Check "${checkName}" threw unexpectedly: ${message}`);
    return {
      check_name: checkName,
      passed: false,
      severity: "error",
      title: checkName.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      description: "Could not complete this check — please try again.",
      fix_instruction:
        "Re-run the scan. If the issue persists, check your network connectivity " +
        "and ensure the store is accessible, then contact support.",
      raw_data: { error: message },
    };
  }
}

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
  console.log(
    `[Scanner] Starting ${scanType} scan for ${shopifyDomain} (merchant: ${merchantId})`
  );
  const startedAt = Date.now();

  // ── 1. Initialise the Shopify data pipeline ─────────────────────────────────
  const executor = await createAdminClient(shopifyDomain);

  // ── 2. Fetch all Shopify data concurrently ──────────────────────────────────
  const [shopInfo, shopPolicies, products, pages] = await Promise.all([
    getShopInfo(executor),
    getShopPolicies(executor),
    getProducts(executor, 50),
    getPages(executor, 20),
  ]);

  console.log(
    `[Scanner] Shopify data fetched in ${Date.now() - startedAt}ms — ` +
      `products: ${products.length}, pages: ${pages.length}`
  );

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

  console.log(
    `[Scanner] Storefront fetches complete in ${Date.now() - startedAt}ms — ` +
      `homepage: HTTP ${homepageFetch?.status ?? "failed"}, ` +
      `product pages sampled: ${productPageUrls.length}`
  );

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

  const [fatalFiveResults, [check6, check7, check8, check9, check10]] =
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
      ]),
    ]);

  const checkResults: CheckResult[] = [
    ...fatalFiveResults,
    check6,
    check7,
    check8,
    check9,
    check10,
  ];

  // ── 5. Aggregate scores and counts ──────────────────────────────────────────
  const totalChecks = checkResults.length; // always 10
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

  console.log(
    `[Scanner] Results — score: ${complianceScore}%, ` +
      `passed: ${passedChecks}/${totalChecks}, ` +
      `critical: ${criticalCount}, warning: ${warningCount}, ` +
      `info: ${infoCount}, errors: ${errorCount}`
  );

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

  const elapsed = Date.now() - startedAt;
  console.log(`[Scanner] Scan ${scanId} complete in ${elapsed}ms.`);

  return {
    scan: scanData as ScanRecord,
    violations: (violationsData ?? []) as ScanViolation[],
  };
}
