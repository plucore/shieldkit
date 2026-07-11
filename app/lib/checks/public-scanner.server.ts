/**
 * app/lib/checks/public-scanner.server.ts
 *
 * Server-only scanner for the public /scan marketing page.
 *
 * Wraps the same compliance-check logic used in scripts/outbound-scanner.ts
 * (no Shopify Admin OAuth required) and exposes a single async entrypoint
 * that the /scan loader/action calls. We deliberately do NOT touch the
 * authenticated in-app scanner under app/lib/checks/index.server.ts.
 *
 * Checks run (subset that works without Admin API):
 *   - contact_information      (public contact/about page text)
 *   - shipping_policy          (/policies/shipping-policy)
 *   - privacy_and_terms        (/policies/privacy-policy, /policies/terms-of-service)
 *   - refund_return_policy     (/policies/refund-policy)
 *   - checkout_transparency    (homepage payment icons)
 *   - storefront_accessibility (password gate + product page reachability)
 *   - structured_data_json_ld  (Product JSON-LD on sampled product pages)
 *   - page_speed               (Google PageSpeed Insights mobile score)
 */

import { load as cheerioLoad } from "cheerio";
import dns from "node:dns/promises";
import {
  detectContactSignals,
  detectPaymentSignals,
  evaluateStructuredDataPages,
} from "./shared/html-detectors.server";

export type Severity = "critical" | "warning" | "info" | "error";

export interface PublicCheckResult {
  check_name: string;
  passed: boolean;
  /** false = ran but couldn't be measured; excluded from the risk score. */
  scorable?: boolean;
  severity: Severity;
  title: string;
  description: string;
  fix_instruction: string;
  raw_data: Record<string, unknown>;
}

export interface PublicScanResult {
  ok: true;
  store_url: string;
  scanned_at: string;
  score: number;
  threat_level: "Minimal" | "Low" | "Elevated" | "High" | "Critical";
  summary: {
    total_checks: number;
    passed_checks: number;
    critical_count: number;
    warning_count: number;
    errored_checks: number;
  };
  results: PublicCheckResult[];
}

export interface PublicScanError {
  ok: false;
  error: string;
}

/* ───────────────────────────────────────────────── SSRF + URL guards ── */

const PRIVATE_IP_PATTERNS: RegExp[] = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\.0\.0\.0$/,
  /^::1$/,
  /^fc[0-9a-f]{2}:/i,
  /^fd[0-9a-f]{2}:/i,
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
    url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
  } catch {
    return { valid: false, error: "That doesn't look like a valid URL." };
  }
  if (url.protocol !== "https:") {
    return {
      valid: false,
      error: "URL must use HTTPS — Google Merchant Center requires HTTPS storefronts.",
    };
  }
  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(url.hostname, { all: true });
  } catch {
    return {
      valid: false,
      error: `Couldn't resolve "${url.hostname}". Make sure the URL is correct and the store is live.`,
    };
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      return {
        valid: false,
        error: "That hostname resolves to a private network address — only public stores can be scanned.",
      };
    }
  }
  return { valid: true, url };
}

/* ─────────────────────────────────────────────────── HTTP utilities ── */

const REQUEST_HEADERS = {
  "User-Agent": "ShieldKit-Compliance-Scanner/1.0 (+https://shieldkit.vercel.app)",
  Accept: "text/html,application/xhtml+xml,application/json",
};

interface PageFetchResult {
  url: string;
  status: number | null;
  html: string | null;
}

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
  fn: () => PublicCheckResult | Promise<PublicCheckResult>
): Promise<PublicCheckResult> {
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
      fix_instruction: "Re-run the scan in a moment.",
      raw_data: { error: message },
    };
  }
}

/* ───────────────────────────────────────────────────────── CHECKS ── */

export function checkContactInformation(
  contactHtml: string | null,
  aboutHtml: string | null,
  homepageHtml: string | null
): PublicCheckResult {
  // Google (since Aug 2021) requires only ONE contact method and accepts a
  // contact form or social profile. Accept any one signal, searched across the
  // contact/about pages AND the homepage header/footer markup (shared detector).
  const signals = detectContactSignals([contactHtml, aboutHtml, homepageHtml]);
  const phoneFound = signals.phoneFound;
  const emailFound = signals.emailFound;
  const poBoxFound = signals.poBoxFound;
  const addressFound = signals.addressFound;

  const contactFormFound =
    (!!contactHtml && stripHtml(contactHtml).trim().length > 0) || signals.contactLinkFound;
  const socialFound = signals.socialFound;

  const methods: string[] = [];
  if (phoneFound) methods.push("phone number");
  if (emailFound) methods.push("email address");
  if (addressFound) methods.push("physical address");
  if (contactFormFound) methods.push("contact page/form");
  if (socialFound) methods.push("social profile");
  const passed = methods.length >= 1;

  const raw_data = {
    phoneFound,
    emailFound,
    addressFound,
    poBoxFound,
    contactFormFound,
    socialFound,
    methods_found: methods,
  };

  if (passed) {
    return {
      check_name: "contact_information",
      passed: true,
      severity: "info",
      title: "Contact Information",
      description: `Contact method${methods.length === 1 ? "" : "s"} detected: ${methods.join(", ")}.`,
      fix_instruction: "No action required.",
      raw_data,
    };
  }

  return {
    check_name: "contact_information",
    passed: false,
    severity: "warning",
    title: "No Contact Method Detected",
    description:
      "No contact method (email, phone, address, contact page, or social profile) could be " +
      "found on your storefront. Google and shoppers expect at least one visible way to reach you. " +
      "(Contact details rendered only by JavaScript can be missed by an automated scan.)",
    fix_instruction:
      "Add at least one — any of these satisfies Google: a support email or phone in your " +
      "header/footer, a Contact page (Shopify Admin → Online Store → Pages; the Contact template " +
      "includes a form), a physical address, or a link to a social business profile.",
    raw_data,
  };
}

function checkShippingPolicy(html: string | null): PublicCheckResult {
  if (!html || !stripHtml(html).trim()) {
    return {
      check_name: "shipping_policy",
      passed: false,
      severity: "critical",
      title: "Missing Shipping Policy",
      description:
        "No shipping policy was found at /policies/shipping-policy. GMC requires one with delivery times and costs.",
      fix_instruction:
        "In Shopify Admin → Settings → Policies, add a Shipping Policy. Include delivery timeframes and costs.",
      raw_data: { policy_present: false },
    };
  }
  const text = stripHtml(html);
  const TIMELINE_RE =
    /\d+\s*(?:to|[-–])\s*\d+\s*(?:business\s+)?days?|\d+\s*(?:business\s+)?days?|within\s+\d+\s*(?:business\s+)?days?|same[\s-]day|next[\s-]day|overnight/i;
  const COST_RE =
    /free\s+shipping|flat[\s-]rate|\$\s*[\d,.]+|calculated\s+at\s+checkout|free\s+on\s+orders|shipping\s+costs?|postage|delivery\s+fee/i;
  const hasTimeline = TIMELINE_RE.test(text);
  const hasCost = COST_RE.test(text);
  const issues: string[] = [];
  if (!hasTimeline) issues.push("no delivery timeline");
  if (!hasCost) issues.push("no shipping cost info");

  if (issues.length === 0) {
    return {
      check_name: "shipping_policy",
      passed: true,
      severity: "info",
      title: "Shipping Policy",
      description: "Policy exists with delivery timelines and costs.",
      fix_instruction: "No action required.",
      raw_data: { hasTimeline, hasCost },
    };
  }
  return {
    check_name: "shipping_policy",
    passed: false,
    severity: "warning",
    title: "Vague Shipping Policy",
    description: `Shipping policy exists but is missing: ${issues.join("; ")}.`,
    fix_instruction:
      "Update your Shipping Policy in Shopify Admin to include clear delivery timeframes (e.g. '3–7 business days') and explicit shipping costs.",
    raw_data: { hasTimeline, hasCost },
  };
}

function checkRefundReturnPolicy(html: string | null): PublicCheckResult {
  if (!html || !stripHtml(html).trim()) {
    return {
      check_name: "refund_return_policy",
      passed: false,
      severity: "critical",
      title: "Missing Refund/Return Policy",
      description:
        "No refund policy was found at /policies/refund-policy. GMC explicitly requires one with a return window, item condition, and refund method.",
      fix_instruction:
        "In Shopify Admin → Settings → Policies, add a Refund Policy. Specify the return window, accepted condition, and how refunds are issued.",
      raw_data: { policy_present: false },
    };
  }
  const text = stripHtml(html).toLowerCase();
  const hasWindow = /\b(?:\d{1,3}|fourteen|thirty|sixty|ninety)\s*(?:day|week|month)/.test(text);
  const hasCondition =
    /(unworn|unused|original\s+packaging|with tags|condition|defective)/.test(text);
  const hasMethod =
    /(refund|store credit|exchange|original\s+payment|method of payment)/.test(text);
  const placeholder = /lorem ipsum|placeholder|edit this/.test(text);

  const signals = [hasWindow, hasCondition, hasMethod].filter(Boolean).length;
  if (signals >= 3 && !placeholder) {
    return {
      check_name: "refund_return_policy",
      passed: true,
      severity: "info",
      title: "Refund/Return Policy",
      description: "Policy exists and covers return window, condition, and refund method.",
      fix_instruction: "No action required.",
      raw_data: { hasWindow, hasCondition, hasMethod, placeholder },
    };
  }
  const missing: string[] = [];
  if (!hasWindow) missing.push("return window (e.g. '30 days')");
  if (!hasCondition) missing.push("required item condition");
  if (!hasMethod) missing.push("refund method");
  return {
    check_name: "refund_return_policy",
    passed: false,
    severity: "critical",
    title: "Incomplete Refund Policy",
    description: placeholder
      ? "Refund policy contains placeholder text. GMC will treat this as missing."
      : `Refund policy is missing: ${missing.join("; ")}.`,
    fix_instruction:
      "Update your Refund Policy in Shopify Admin → Settings → Policies. Specify the exact return window, item condition required, and how refunds are issued.",
    raw_data: { hasWindow, hasCondition, hasMethod, placeholder, missing },
  };
}

function checkPrivacyAndTerms(
  privacyHtml: string | null,
  termsHtml: string | null
): PublicCheckResult {
  const privacyPresent = !!(privacyHtml && stripHtml(privacyHtml).trim());
  const termsPresent = !!(termsHtml && stripHtml(termsHtml).trim());
  if (privacyPresent && termsPresent) {
    return {
      check_name: "privacy_and_terms",
      passed: true,
      severity: "info",
      title: "Privacy Policy & Terms of Service",
      description: "Both Privacy Policy and Terms of Service are present.",
      fix_instruction: "No action required.",
      raw_data: { privacyPresent, termsPresent },
    };
  }
  if (!privacyPresent) {
    return {
      check_name: "privacy_and_terms",
      passed: false,
      severity: "critical",
      title: termsPresent ? "Missing Privacy Policy" : "Missing Privacy Policy and Terms",
      description:
        "GMC requires a privacy policy. GDPR/CCPA also legally require one. " +
        (!termsPresent ? "Terms of service is also missing." : ""),
      fix_instruction:
        "In Shopify Admin → Settings → Policies, add both policies using the built-in templates.",
      raw_data: { privacyPresent, termsPresent },
    };
  }
  return {
    check_name: "privacy_and_terms",
    passed: false,
    severity: "warning",
    title: "Missing Terms of Service",
    description:
      "Privacy Policy is present, but Terms of Service is missing. ToS is strongly recommended.",
    fix_instruction:
      "In Shopify Admin → Settings → Policies, generate a Terms of Service from the template.",
    raw_data: { privacyPresent, termsPresent },
  };
}

export function checkCheckoutTransparency(
  storeUrl: string,
  homepageHtml: string | null
): PublicCheckResult {
  // Displaying payment methods is a trust best-practice, not a GMC requirement
  // (Google removed that rule in 2021), so this check is informational only.
  if (!homepageHtml) {
    return {
      check_name: "checkout_transparency",
      passed: true,
      severity: "info",
      title: "Payment Methods — Not Verified",
      description:
        "The storefront homepage could not be fetched, so accepted payment methods could not " +
        "be checked. Displaying payment methods is a trust best-practice, not a requirement.",
      fix_instruction:
        "Ensure your store is published and not password-protected, then re-run the scan.",
      raw_data: { store_url: storeUrl },
    };
  }
  // Payment-icon detection (shared, HTML-only).
  const { found: list, structural } = detectPaymentSignals(homepageHtml);

  if (list.length > 0 || structural.length > 0) {
    const summary =
      list.length > 0
        ? `payment method icon(s): ${list.join(", ")}`
        : `payment display markup: ${structural.join(", ")}`;
    return {
      check_name: "checkout_transparency",
      passed: true,
      severity: "info",
      title: "Payment Methods Displayed",
      description: `Storefront advertises accepted payment methods (${summary}).`,
      fix_instruction: "No action required.",
      raw_data: { payment_icons_found: list, structural_signals: structural },
    };
  }
  return {
    check_name: "checkout_transparency",
    passed: true,
    severity: "info",
    title: "Payment Methods — Not Detected",
    description:
      "No payment method icons were detected in the storefront's initial HTML. This is a trust " +
      "best-practice, not a Google Merchant Center requirement, and automated scans can miss icons " +
      "that load via JavaScript — so no action may be needed.",
    fix_instruction:
      "Payment icons usually appear automatically once a provider is active. Verify your providers " +
      "under Shopify Admin → Settings → Payments; most themes then render the icons from your active gateways.",
    raw_data: { payment_icons_found: [], structural_signals: [] },
  };
}

function checkStorefrontAccessibility(
  storeUrl: string,
  productPageResults: PageFetchResult[],
  homepageStatus: number | null,
  homepageHtml: string | null
): PublicCheckResult {
  let passwordProtected = false;
  const signals: string[] = [];
  if (homepageStatus === 401) {
    passwordProtected = true;
    signals.push("HTTP 401");
  }
  if (homepageHtml) {
    const $ = cheerioLoad(homepageHtml);
    const bodyClass = ($("body").attr("class") ?? "").toLowerCase();
    const title = $("title").text().toLowerCase();
    if (bodyClass.includes("template-password")) {
      passwordProtected = true;
      signals.push('body class "template-password"');
    }
    if (title.includes("enter using password") || title.includes("password required")) {
      passwordProtected = true;
      signals.push("password page title");
    }
    if ($("form[action='/password']").length > 0) {
      passwordProtected = true;
      signals.push("password form");
    }
  }
  if (passwordProtected) {
    return {
      check_name: "storefront_accessibility",
      passed: false,
      severity: "critical",
      title: "Storefront is Password Protected",
      description:
        "The store is behind a password page. GMC cannot crawl or approve password-protected stores.",
      fix_instruction:
        "In Online Store → Preferences, uncheck 'Restrict access to visitors with the password'.",
      raw_data: { signals },
    };
  }
  const failed = productPageResults.filter((r) => r.status !== 200);
  if (failed.length > 0 && productPageResults.length > 0) {
    return {
      check_name: "storefront_accessibility",
      passed: false,
      severity: "warning",
      title: "Product Pages Returning Non-200",
      description: `${failed.length} of ${productPageResults.length} sampled product pages did not return HTTP 200.`,
      fix_instruction:
        "Verify the affected products are published to the Online Store sales channel.",
      raw_data: { product_pages: productPageResults.map((r) => ({ url: r.url, status: r.status })) },
    };
  }
  return {
    check_name: "storefront_accessibility",
    passed: true,
    severity: "info",
    title: "Storefront Accessibility",
    description: `Storefront is publicly accessible (HTTP ${homepageStatus ?? "unknown"}).`,
    fix_instruction: "No action required.",
    raw_data: { store_url: storeUrl },
  };
}

export function checkStructuredDataJsonLd(
  productPageResults: PageFetchResult[]
): PublicCheckResult {
  if (productPageResults.length === 0) {
    return {
      check_name: "structured_data_json_ld",
      passed: true,
      severity: "info",
      title: "Structured Data (JSON-LD)",
      description: "No product pages were available to scan.",
      fix_instruction: "No action required.",
      raw_data: { pages_scanned: 0 },
    };
  }
  // HTML-only structured-data evaluation (shared): absent (no Product node in
  // static HTML) is treated as unverified, not a failure.
  const { pagesValid, pagesIncomplete, pagesAbsent, incompleteMissing } =
    evaluateStructuredDataPages(productPageResults);

  const raw_data = {
    pages_scanned: productPageResults.length,
    pages_valid: pagesValid,
    pages_incomplete: pagesIncomplete,
    pages_absent: pagesAbsent,
  };

  // Present-but-malformed on ≥1 page → WARNING.
  if (pagesIncomplete > 0) {
    return {
      check_name: "structured_data_json_ld",
      passed: false,
      severity: "warning",
      title: "Incomplete Product JSON-LD",
      description: `Product schema is present but missing required fields on ${pagesIncomplete} of ${productPageResults.length} page(s): ${[...new Set(incompleteMissing)].join(", ")}.`,
      fix_instruction:
        "Ensure your theme's product template outputs complete Product JSON-LD: name, image, " +
        "description, and offers with a price and priceCurrency (offers may be a single object, an " +
        "array of per-variant offers, or an AggregateOffer with lowPrice/highPrice). Validate at " +
        "https://search.google.com/test/rich-results.",
      raw_data,
    };
  }

  // At least one page validated cleanly → PASS.
  if (pagesValid > 0) {
    return {
      check_name: "structured_data_json_ld",
      passed: true,
      severity: "info",
      title: "Structured Data (JSON-LD)",
      description: `Valid Product schema found on ${pagesValid} of ${productPageResults.length} sampled page(s).`,
      fix_instruction: "No action required.",
      raw_data,
    };
  }

  // No Product schema in any static HTML — commonly injected client-side.
  return {
    check_name: "structured_data_json_ld",
    passed: true,
    severity: "info",
    title: "Structured Data (JSON-LD) — Not Verified",
    description:
      "No Product structured data was found in the initial HTML of the sampled product page(s). " +
      "Many Shopify themes inject JSON-LD via JavaScript, which an automated fetch cannot see, so this is not necessarily a problem.",
    fix_instruction:
      "Confirm your products emit Product structured data with Google's Rich Results Test " +
      "(https://search.google.com/test/rich-results). If it passes there, no action is needed.",
    raw_data,
  };
}

async function checkPageSpeed(storeUrl: string): Promise<PublicCheckResult> {
  const apiKey = process.env.GOOGLE_PAGESPEED_API_KEY;
  const apiUrl =
    `https://www.googleapis.com/pagespeedonline/v5/runPagespeed` +
    `?url=${encodeURIComponent(storeUrl)}&strategy=mobile` +
    (apiKey ? `&key=${encodeURIComponent(apiKey)}` : "");
  try {
    const res = await fetch(apiUrl, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      return {
        check_name: "page_speed",
        passed: true,
        scorable: false,
        severity: "info",
        title: "Page Speed — API Unavailable",
        description: `PageSpeed Insights API returned HTTP ${res.status}. Check skipped.`,
        fix_instruction: "Re-run later or set GOOGLE_PAGESPEED_API_KEY.",
        raw_data: { api_status: res.status },
      };
    }
    const psi = (await res.json()) as {
      lighthouseResult?: { categories?: { performance?: { score?: number } } };
    };
    const raw = psi.lighthouseResult?.categories?.performance?.score ?? null;
    const score = raw !== null ? Math.round(raw * 100) : null;
    if (score === null) {
      return {
        check_name: "page_speed",
        passed: true,
        scorable: false,
        severity: "info",
        title: "Page Speed — No Score Returned",
        description: "PageSpeed Insights did not return a score.",
        fix_instruction: "Re-scan after the store is fully published.",
        raw_data: {},
      };
    }
    if (score >= 50) {
      return {
        check_name: "page_speed",
        passed: true,
        severity: "info",
        title: "Page Speed",
        description: `Mobile performance score: ${score}/100.`,
        fix_instruction: "No action required.",
        raw_data: { score },
      };
    }
    return {
      check_name: "page_speed",
      passed: false,
      // Page speed isn't a GMC suspension criterion — informational, not a warning.
      severity: "info",
      title: "Slow Mobile Page Speed",
      description: `Mobile performance score is ${score}/100. Threshold for GMC-friendly stores is 50+.`,
      fix_instruction:
        "Run a full audit at pagespeed.web.dev. Common fixes: compress images to WebP, lazy-load offscreen images, minimize third-party scripts.",
      raw_data: { score },
    };
  } catch (err) {
    return {
      check_name: "page_speed",
      passed: true,
      scorable: false,
      severity: "info",
      title: "Page Speed — Check Skipped",
      description: "PageSpeed Insights could not be reached.",
      fix_instruction: "Check skipped — no action required.",
      raw_data: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

/* ─────────────────────────────────────────── Public risk score ── */

// computeRiskScore lives in a non-server sibling so the public /scan UI
// component can import it without dragging server-only deps into the
// client bundle. See app/lib/checks/public-risk-score.ts for the
// weighting rationale.
export { computeRiskScore } from "./public-risk-score";

/* ───────────────────────────────────────────────── Threat level ── */

function deriveThreatLevel(score: number, criticals: number): PublicScanResult["threat_level"] {
  if (criticals >= 3 || score < 40) return "Critical";
  if (criticals >= 2 || score < 60) return "High";
  if (criticals >= 1 || score < 75) return "Elevated";
  if (score < 90) return "Low";
  return "Minimal";
}

/* ─────────────────────────────────────────────────── Public API ── */

export async function runPublicScan(
  rawUrl: string
): Promise<PublicScanResult | PublicScanError> {
  const validation = await validateAndSanitizeUrl(rawUrl);
  if (!validation.valid) {
    return { ok: false, error: validation.error };
  }
  const storeUrl = validation.url.origin;

  // Fetch all public data concurrently.
  const [
    homepageFetch,
    contactFetch,
    aboutFetch,
    shippingFetch,
    privacyFetch,
    termsFetch,
    refundFetch,
    productsJson,
  ] = await Promise.all([
    fetchPage(`${storeUrl}/`),
    fetchPage(`${storeUrl}/pages/contact-us`).then((r) =>
      r && r.status === 200 ? r : fetchPage(`${storeUrl}/pages/contact`)
    ),
    fetchPage(`${storeUrl}/pages/about-us`).then((r) =>
      r && r.status === 200 ? r : fetchPage(`${storeUrl}/pages/about`)
    ),
    fetchPage(`${storeUrl}/policies/shipping-policy`),
    fetchPage(`${storeUrl}/policies/privacy-policy`),
    fetchPage(`${storeUrl}/policies/terms-of-service`),
    fetchPage(`${storeUrl}/policies/refund-policy`),
    fetchJson<{ products: Array<{ handle: string }> }>(
      `${storeUrl}/products.json?limit=5`
    ),
  ]);

  if (!homepageFetch) {
    return {
      ok: false,
      error: `Couldn't reach ${storeUrl} — make sure it's a live, public Shopify storefront.`,
    };
  }

  const handles = (productsJson?.products ?? []).slice(0, 3).map((p) => p.handle);
  const productUrls = handles.map((h) => `${storeUrl}/products/${h}`);
  const productFetches = await Promise.all(productUrls.map((u) => fetchPage(u)));
  const productResults: PageFetchResult[] = productUrls.map((url, i) => ({
    url,
    status: productFetches[i]?.status ?? null,
    html: productFetches[i]?.html ?? null,
  }));

  const results = await Promise.all([
    safeCheck("contact_information", () =>
      checkContactInformation(
        contactFetch?.status === 200 ? contactFetch.html : null,
        aboutFetch?.status === 200 ? aboutFetch.html : null,
        homepageFetch?.html ?? null
      )
    ),
    safeCheck("shipping_policy", () =>
      checkShippingPolicy(shippingFetch?.status === 200 ? shippingFetch.html : null)
    ),
    safeCheck("refund_return_policy", () =>
      checkRefundReturnPolicy(refundFetch?.status === 200 ? refundFetch.html : null)
    ),
    safeCheck("privacy_and_terms", () =>
      checkPrivacyAndTerms(
        privacyFetch?.status === 200 ? privacyFetch.html : null,
        termsFetch?.status === 200 ? termsFetch.html : null
      )
    ),
    safeCheck("checkout_transparency", () =>
      checkCheckoutTransparency(storeUrl, homepageFetch?.html ?? null)
    ),
    safeCheck("storefront_accessibility", () =>
      checkStorefrontAccessibility(
        storeUrl,
        productResults,
        homepageFetch?.status ?? null,
        homepageFetch?.html ?? null
      )
    ),
    safeCheck("structured_data_json_ld", () => checkStructuredDataJsonLd(productResults)),
    safeCheck("page_speed", () => checkPageSpeed(storeUrl)),
  ]);

  const passed = results.filter((r) => r.passed).length;
  const errored = results.filter((r) => r.severity === "error").length;
  const scorable = results.length - errored;
  const score = scorable > 0 ? Math.round((passed / scorable) * 100) : 0;
  const criticals = results.filter((r) => !r.passed && r.severity === "critical").length;
  const warnings = results.filter((r) => !r.passed && r.severity === "warning").length;

  return {
    ok: true,
    store_url: storeUrl,
    scanned_at: new Date().toISOString(),
    score,
    threat_level: deriveThreatLevel(score, criticals),
    summary: {
      total_checks: results.length,
      passed_checks: passed,
      critical_count: criticals,
      warning_count: warnings,
      errored_checks: errored,
    },
    results,
  };
}
