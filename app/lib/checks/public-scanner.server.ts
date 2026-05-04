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

export type Severity = "critical" | "warning" | "info" | "error";

export interface PublicCheckResult {
  check_name: string;
  passed: boolean;
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

function checkContactInformation(
  contactHtml: string | null,
  aboutHtml: string | null
): PublicCheckResult {
  const text = [contactHtml, aboutHtml]
    .filter(Boolean)
    .map((h) => stripHtml(h!))
    .join(" ");

  if (!text.trim()) {
    return {
      check_name: "contact_information",
      passed: false,
      severity: "critical",
      title: "Contact Information — Unable to Scan",
      description:
        "Could not fetch your contact or about page. The store may be password-protected.",
      fix_instruction:
        "Make sure /pages/contact-us and /pages/about-us are published and publicly accessible.",
      raw_data: { error: "no_pages_fetched" },
    };
  }

  const PHONE_RE =
    /(?:\+?1[-.\s]?)?\(?([2-9]\d{2})\)?[-.\s]([2-9]\d{2})[-.\s](\d{4})|\+[1-9]\d{1,2}[-.\s]\d{3,5}[-.\s]\d{3,5}(?:[-.\s]\d{2,4})?/g;
  const phoneFound = PHONE_RE.test(text);
  const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const emailFound = EMAIL_RE.test(text);
  const ADDRESS_RE =
    /\d+\s+[A-Za-z]+(?:\s+[A-Za-z]+){0,2}\s+(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Drive|Dr\.?|Lane|Ln\.?|Boulevard|Blvd\.?|Way|Place|Pl\.?|Court|Ct\.?|Terrace|Terr\.?)\b/i;
  const PO_BOX_RE = /\bP\.?O\.?\s*Box\b/i;
  const addressFound = ADDRESS_RE.test(text);
  const poBoxFound = PO_BOX_RE.test(text);

  const found = [phoneFound, emailFound, addressFound].filter(Boolean).length;
  const passed = found >= 2;

  if (passed) {
    return {
      check_name: "contact_information",
      passed: true,
      severity: "info",
      title: "Contact Information",
      description: `${found} of 3 contact methods found on public pages.`,
      fix_instruction: "No action required.",
      raw_data: { phoneFound, emailFound, addressFound, poBoxFound, found },
    };
  }

  const missing: string[] = [];
  if (!phoneFound) missing.push("phone number");
  if (!emailFound) missing.push("email address");
  if (!addressFound) missing.push("physical street address");

  return {
    check_name: "contact_information",
    passed: false,
    severity: "critical",
    title: "Insufficient Contact Information",
    description:
      `Only ${found} of 3 required contact methods are publicly visible. Missing: ${missing.join(", ")}.` +
      (poBoxFound ? " A PO Box was detected — GMC requires a physical street address." : ""),
    fix_instruction:
      "Add at least 2 of: a phone number, an email at your store domain, or a physical street address (not a PO Box) to your Contact or About page.",
    raw_data: { phoneFound, emailFound, addressFound, poBoxFound, missing },
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

function checkCheckoutTransparency(
  storeUrl: string,
  homepageHtml: string | null
): PublicCheckResult {
  if (!homepageHtml) {
    return {
      check_name: "checkout_transparency",
      passed: false,
      severity: "warning",
      title: "Checkout Transparency — Unable to Scan",
      description: "The public storefront homepage could not be fetched.",
      fix_instruction:
        "Ensure your store is published and not password-protected, then re-run the scan.",
      raw_data: { store_url: storeUrl },
    };
  }
  const $ = cheerioLoad(homepageHtml);
  const PAYMENT_KEYWORDS = [
    "visa", "mastercard", "master-card",
    "paypal", "amex", "american-express",
    "discover", "apple-pay", "applepay",
    "google-pay", "googlepay", "gpay", "maestro", "jcb",
    "diners", "shop-pay", "shopify-pay",
    "unionpay", "klarna", "afterpay", "clearpay",
  ];
  const found = new Set<string>();
  const scan = (text: string) => {
    const lower = text.toLowerCase();
    for (const kw of PAYMENT_KEYWORDS) if (lower.includes(kw)) found.add(kw);
  };
  $("img").each((_, el) => {
    scan($(el).attr("src") ?? "");
    scan($(el).attr("alt") ?? "");
  });
  $("[class]").each((_, el) => scan($(el).attr("class") ?? ""));
  $("[aria-label]").each((_, el) => scan($(el).attr("aria-label") ?? ""));

  const list = Array.from(found);
  if (list.length > 0) {
    return {
      check_name: "checkout_transparency",
      passed: true,
      severity: "info",
      title: "Checkout Transparency",
      description: `${list.length} payment method icon(s) detected: ${list.join(", ")}.`,
      fix_instruction: "No action required.",
      raw_data: { payment_icons_found: list },
    };
  }
  return {
    check_name: "checkout_transparency",
    passed: false,
    severity: "warning",
    title: "No Payment Method Icons Detected",
    description:
      "Shoppers expect to see accepted payment methods before checkout. None were found on the homepage.",
    fix_instruction:
      "In Online Store → Themes → Theme settings → Footer, enable payment icons.",
    raw_data: { payment_icons_found: [] },
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

function checkStructuredDataJsonLd(
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
  const REQUIRED = ["name", "image", "description", "offers"];
  let allMissing: string[] = [];
  let pagesWithSchema = 0;
  let pagesWithoutSchema = 0;
  for (const page of productPageResults) {
    if (!page.html) {
      pagesWithoutSchema++;
      allMissing = [...new Set([...allMissing, ...REQUIRED])];
      continue;
    }
    const $ = cheerioLoad(page.html);
    let product: Record<string, unknown> | null = null;
    $('script[type="application/ld+json"]').each((_, el) => {
      if (product) return;
      try {
        const raw = JSON.parse($(el).html() ?? "{}");
        const candidates: unknown[] = Array.isArray(raw)
          ? raw
          : Array.isArray(raw["@graph"])
            ? raw["@graph"]
            : [raw];
        for (const node of candidates) {
          if (
            node &&
            typeof node === "object" &&
            !Array.isArray(node) &&
            (node as Record<string, unknown>)["@type"] === "Product"
          ) {
            product = node as Record<string, unknown>;
            break;
          }
        }
      } catch {
        // ignore
      }
    });
    if (!product) {
      pagesWithoutSchema++;
      allMissing = [...new Set([...allMissing, ...REQUIRED])];
      continue;
    }
    pagesWithSchema++;
    for (const f of REQUIRED) if (!(product as Record<string, unknown>)[f]) allMissing.push(f);
  }
  if (allMissing.length === 0) {
    return {
      check_name: "structured_data_json_ld",
      passed: true,
      severity: "info",
      title: "Structured Data (JSON-LD)",
      description: `Valid Product schema found on all ${productPageResults.length} sampled page(s).`,
      fix_instruction: "No action required.",
      raw_data: { pages_with_schema: pagesWithSchema },
    };
  }
  return {
    check_name: "structured_data_json_ld",
    passed: false,
    severity: "warning",
    title: "Incomplete or Missing Product JSON-LD",
    description:
      pagesWithoutSchema === productPageResults.length
        ? "No Product JSON-LD schema was found on any sampled page."
        : `Schema is missing fields: ${[...new Set(allMissing)].join(", ")}.`,
    fix_instruction:
      "Shopify themes inject Product JSON-LD automatically. Verify your theme's product.liquid has not had structured data removed. Required: name, image, description, offers (price, priceCurrency, availability).",
    raw_data: { pages_with_schema: pagesWithSchema, pages_without_schema: pagesWithoutSchema, missing: [...new Set(allMissing)] },
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
      severity: "warning",
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
      severity: "info",
      title: "Page Speed — Check Skipped",
      description: "PageSpeed Insights could not be reached.",
      fix_instruction: "Check skipped — no action required.",
      raw_data: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

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
        aboutFetch?.status === 200 ? aboutFetch.html : null
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
