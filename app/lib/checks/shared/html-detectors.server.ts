/**
 * app/lib/checks/shared/html-detectors.server.ts
 *
 * SINGLE SOURCE OF TRUTH for the pure, HTML-only detection used by three checks
 * that historically existed as three near-duplicate inline copies (the
 * authenticated in-app scanner, the public /scan scanner, and the standalone
 * CLI) — a triple-copy that caused the 2026-07 false-positive incident because
 * every fix had to be ported three times.
 *
 * RULE: fix these detectors HERE, never re-copy per surface. Each surface wraps
 * the raw signals below into its own CheckResult (titles/severities/raw_data)
 * and, for the authenticated scanner, layers Admin-API augmentation on top.
 *
 * These functions are PURE (HTML in → signals out), no network, no Admin API.
 *
 * NOTE: scripts/outbound-scanner.ts is intentionally NOT wired to this module —
 * it must run standalone via `node --experimental-strip-types`, which cannot
 * resolve extensionless relative imports, and adding a runner (tsx) would add a
 * dependency. It keeps a self-contained mirror of these detectors; keep the two
 * in sync (see the header note in that file).
 */

import { load as cheerioLoad } from "cheerio";
import { stripHtml } from "../helpers.server";
import { PAYMENT_KEYWORDS, PAYMENT_STRUCTURAL_SIGNALS, SOCIAL_RE } from "../constants";

/* ─────────────────────────────────────────────── Contact detection ── */

export interface ContactSignals {
  /** Phone number in visible text, or a `tel:` link. */
  phoneFound: boolean;
  /** Any email in visible text, or a `mailto:` link. HTML-only (Admin contact email is layered on by the caller). */
  emailFound: boolean;
  /** Street-address regex or a PO Box in visible text. HTML-only (billing address is layered on by the caller). */
  addressFound: boolean;
  poBoxFound: boolean;
  /** A `/contact` (or `/pages/contact`) link in the raw markup. */
  contactLinkFound: boolean;
  /** A social business-profile link in the raw markup. */
  socialFound: boolean;
}

const PHONE_RE =
  /(?:\+?1[-.\s]?)?\(?([2-9]\d{2})\)?[-.\s]([2-9]\d{2})[-.\s](\d{4})|\+[1-9]\d{1,2}[-.\s]\d{3,5}[-.\s]\d{3,5}(?:[-.\s]\d{2,4})?/;
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;
/** Exported so the authenticated scanner can reuse it for the Admin billing-address augmentation. */
export const ADDRESS_RE =
  /\d+\s+[A-Za-z]+(?:\s+[A-Za-z]+){0,2}\s+(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Drive|Dr\.?|Lane|Ln\.?|Boulevard|Blvd\.?|Way|Place|Pl\.?|Court|Ct\.?|Terrace|Terr\.?)\b/i;
const PO_BOX_RE = /\bP\.?O\.?\s*Box\b/i;
const CONTACT_LINK_RE = /href\s*=\s*["'][^"']*\/(?:pages\/)?contact/i;

/**
 * Detects HTML-only contact signals across every passed HTML document (page
 * bodies, homepage markup, etc.). Google (since Aug 2021) requires only ONE
 * contact method and accepts a contact form or social profile, so callers pass
 * when ANY single signal is present. Detection is biased to false negatives.
 */
export function detectContactSignals(
  htmls: Array<string | null | undefined>,
): ContactSignals {
  const present = htmls.filter((h): h is string => !!h);
  const visibleText = present.map((h) => stripHtml(h)).join(" ");
  const rawMarkup = present.join(" ").toLowerCase();

  const poBoxFound = PO_BOX_RE.test(visibleText);
  return {
    phoneFound: PHONE_RE.test(visibleText) || rawMarkup.includes("tel:"),
    emailFound: EMAIL_RE.test(visibleText) || rawMarkup.includes("mailto:"),
    addressFound: ADDRESS_RE.test(visibleText) || poBoxFound,
    poBoxFound,
    contactLinkFound: CONTACT_LINK_RE.test(rawMarkup),
    socialFound: SOCIAL_RE.test(rawMarkup),
  };
}

/* ─────────────────────────────────────────────── Payment detection ── */

export interface PaymentSignals {
  /** Brand keywords found (DOM order, deduped). */
  found: string[];
  /** Structural markers found (in PAYMENT_STRUCTURAL_SIGNALS order). */
  structural: string[];
  /** True if any brand keyword OR structural marker was found. */
  detected: boolean;
}

/**
 * Detects payment-method advertising in the homepage HTML. Broad on purpose:
 * many themes render icons as inline SVGs whose name lives only in
 * <title>/id/aria-labelledby, inject them with JS, or expose them via
 * data-enabled-payment-types / Shop Pay buttons.
 */
export function detectPaymentSignals(homepageHtml: string): PaymentSignals {
  const $ = cheerioLoad(homepageHtml);

  const foundIcons = new Set<string>();
  const checkText = (text: string) => {
    const lower = text.toLowerCase();
    for (const kw of PAYMENT_KEYWORDS) {
      if (lower.includes(kw)) foundIcons.add(kw);
    }
  };

  // <img> — src and alt attributes.
  $("img").each((_, el) => {
    checkText($(el).attr("src") ?? "");
    checkText($(el).attr("alt") ?? "");
  });

  // SVG <use> sprite references.
  $("use").each((_, el) => {
    checkText($(el).attr("xlink:href") ?? "");
    checkText($(el).attr("href") ?? "");
  });

  // SVG <title> element TEXT — Shopify stock icons put the brand name here
  // (e.g. <title id="pi-visa">Visa</title>), never in a scanned attribute.
  $("title").each((_, el) => {
    checkText($(el).text());
  });

  // Accessible names and identifiers (id/aria-labelledby="pi-visa") + payment
  // data attributes.
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
    },
  );

  const lowerHtml = homepageHtml.toLowerCase();
  const structural = PAYMENT_STRUCTURAL_SIGNALS.filter((s) => lowerHtml.includes(s));
  const found = Array.from(foundIcons);

  return { found, structural, detected: found.length > 0 || structural.length > 0 };
}

/* ─────────────────────────────────────────────── JSON-LD detection ── */

/** Normalises a JSON-LD `offers` value to an array of offer objects. */
export function normalizeOffers(offers: unknown): Record<string, unknown>[] {
  if (Array.isArray(offers)) {
    return offers.filter(
      (o): o is Record<string, unknown> => !!o && typeof o === "object" && !Array.isArray(o),
    );
  }
  if (offers && typeof offers === "object") {
    return [offers as Record<string, unknown>];
  }
  return [];
}

/** True if an offer node carries a usable price (Offer.price or AggregateOffer.low/highPrice). */
export function offerHasPrice(o: Record<string, unknown>): boolean {
  const present = (v: unknown) => v !== undefined && v !== null && v !== "";
  return (
    present(o["price"]) ||
    present(o["lowPrice"]) ||
    present(o["highPrice"]) ||
    (!!o["priceSpecification"] && typeof o["priceSpecification"] === "object")
  );
}

/** True if an offer node carries a currency, either top-level or nested in priceSpecification. */
export function offerHasCurrency(o: Record<string, unknown>): boolean {
  if (o["priceCurrency"]) return true;
  const ps = o["priceSpecification"];
  return (
    !!ps &&
    typeof ps === "object" &&
    !Array.isArray(ps) &&
    !!(ps as Record<string, unknown>)["priceCurrency"]
  );
}

/**
 * Parses a page's HTML and returns the first `@type: "Product"` JSON-LD node
 * (handling top-level arrays and `@graph`), plus whether any ld+json block was
 * seen at all (to distinguish "no JSON-LD" from "JSON-LD but no Product node").
 */
export function findProductSchema(html: string): {
  productSchema: Record<string, unknown> | null;
  sawAnyJsonLd: boolean;
} {
  const $ = cheerioLoad(html);
  let productSchema: Record<string, unknown> | null = null;
  let sawAnyJsonLd = false;

  $('script[type="application/ld+json"]').each((_, el) => {
    sawAnyJsonLd = true;
    if (productSchema) return;
    try {
      const raw = JSON.parse($(el).html() ?? "{}") as Record<string, unknown>;
      const candidates: unknown[] = Array.isArray(raw)
        ? raw
        : Array.isArray(raw["@graph"])
          ? (raw["@graph"] as unknown[])
          : [raw];

      for (const node of candidates) {
        if (node && typeof node === "object" && !Array.isArray(node)) {
          const t = (node as Record<string, unknown>)["@type"];
          const types = Array.isArray(t) ? t : [t];
          // ProductGroup is schema.org's type for a variant parent and is what
          // Shopify's own product template emits for any product WITH VARIANTS.
          // Matching only "Product" reported "No Product JSON-LD schema found"
          // on such stores — a false negative that reads to the merchant as
          // "your products are not set up for Google" when they are. Verified
          // live on izzyplants.com 2026-07-28: @type ProductGroup with three
          // Product nodes under hasVariant.
          const isProductLike =
            types.includes("Product") || types.includes("ProductGroup");
          if (isProductLike) {
            productSchema = node as Record<string, unknown>;
            break;
          }
        }
      }
    } catch {
      // Malformed JSON-LD block — ignore; other blocks may still parse.
    }
  });

  return { productSchema, sawAnyJsonLd };
}

/**
 * Returns the list of required Product fields missing from a schema node.
 * Required: name, image, description, and offers with a price + priceCurrency.
 * `offers` may be a single Offer, an array of Offers, or an AggregateOffer.
 */
export function missingRequiredProductFields(
  productSchema: Record<string, unknown>,
): string[] {
  // A ProductGroup splits the required fields across two levels: the group
  // carries name/description/brand, and each hasVariant Product carries
  // image/offers/sku/gtin. Neither level satisfies the requirements alone, so
  // validating only the top level reported "missing image, missing offers" on
  // a product whose data was complete — a false positive layered on top of the
  // ProductGroup false negative fixed in findProductSchema above. Treat the
  // group and its variants as ONE product: a field is present if it appears on
  // the group OR on any variant. (Verified live on izzyplants.com 2026-07-28:
  // description on the group, image + offers on the variants.)
  const variants: Record<string, unknown>[] = Array.isArray(
    productSchema["hasVariant"],
  )
    ? (productSchema["hasVariant"] as unknown[]).filter(
        (v): v is Record<string, unknown> =>
          !!v && typeof v === "object" && !Array.isArray(v),
      )
    : [];
  const levels = [productSchema, ...variants];
  const presentSomewhere = (field: string) => levels.some((l) => !!l[field]);

  const missing: string[] = [];
  for (const field of ["name", "image", "description"] as const) {
    if (!presentSomewhere(field)) missing.push(field);
  }

  const allOffers = levels.flatMap((l) =>
    l["offers"] ? normalizeOffers(l["offers"]) : [],
  );
  if (allOffers.length === 0) {
    missing.push("offers");
  } else {
    if (!allOffers.some(offerHasPrice)) missing.push("offers.price");
    if (!allOffers.some(offerHasCurrency)) missing.push("offers.priceCurrency");
  }
  return missing;
}

export interface StructuredDataTally {
  pagesValid: number;
  pagesIncomplete: number;
  pagesAbsent: number;
  /** Flat list of required fields missing across the incomplete pages. */
  incompleteMissing: string[];
}

/**
 * HTML-only structured-data evaluation used by the /scan surface (and mirrored
 * by the CLI). A page with no Product node in static HTML counts as ABSENT
 * (unverified — likely JS-injected), never as a failure. A page whose Product
 * schema is present but missing required fields counts as INCOMPLETE.
 */
export function evaluateStructuredDataPages(
  pages: Array<{ html: string | null }>,
): StructuredDataTally {
  let pagesValid = 0;
  let pagesIncomplete = 0;
  let pagesAbsent = 0;
  const incompleteMissing: string[] = [];

  for (const page of pages) {
    if (!page.html) {
      pagesAbsent++;
      continue;
    }
    const { productSchema } = findProductSchema(page.html);
    if (!productSchema) {
      pagesAbsent++;
      continue;
    }
    const missing = missingRequiredProductFields(productSchema);
    if (missing.length === 0) pagesValid++;
    else {
      pagesIncomplete++;
      incompleteMissing.push(...missing);
    }
  }

  return { pagesValid, pagesIncomplete, pagesAbsent, incompleteMissing };
}

/**
 * Password-gate detection — the THIRD detector to be consolidated here.
 *
 * It existed as three hand copies (the authenticated check, the public /scan
 * scanner, and the CLI mirror) and they had already diverged:
 * `#shopify-challenge-page` was a signal in two of them and missing from the
 * public one, so the same password-protected storefront could be detected by the
 * in-app scan and missed by the lead-gen scan of the same store.
 *
 * That is the exact shape of the 2026-07 incident this module was created to
 * end — see the header. Fix password detection HERE, never per surface.
 * scripts/outbound-scanner.ts keeps a mirror because it must run standalone;
 * a test asserts the two stay in step.
 */
export interface PasswordGateResult {
  passwordProtected: boolean;
  /** Human-readable evidence, for raw_data. */
  signals: string[];
}

export function detectPasswordGate(
  html: string | null,
  homepageStatus: number | null,
): PasswordGateResult {
  const signals: string[] = [];
  let passwordProtected = false;

  if (homepageStatus === 401) {
    passwordProtected = true;
    signals.push("HTTP 401 Unauthorized");
  }

  if (html) {
    const $ = cheerioLoad(html);
    const bodyClass = ($("body").attr("class") ?? "").toLowerCase();
    const pageTitle = $("title").text();
    const titleLower = pageTitle.toLowerCase();

    if (bodyClass.includes("template-password")) {
      passwordProtected = true;
      signals.push('body class "template-password" detected');
    }
    if (
      titleLower.includes("enter using password") ||
      titleLower.includes("password required")
    ) {
      passwordProtected = true;
      signals.push(`page title indicates password gate: "${pageTitle}"`);
    }
    if ($("form[action='/password']").length > 0) {
      passwordProtected = true;
      signals.push('password form (action="/password") present');
    }
    // Was present in the authenticated + CLI copies and MISSING from the public
    // one. Kept — the union of the copies is the correct detector, since each
    // signal was added because a real store exhibited it.
    if ($("#shopify-challenge-page").length > 0) {
      passwordProtected = true;
      signals.push("#shopify-challenge-page element detected");
    }
  }

  return { passwordProtected, signals };
}
