/**
 * app/lib/checks/constants.ts
 *
 * Constants shared across compliance check functions.
 */

// ─── Policy content-quality regexes ────────────────────────────────────────
// Lifted out of the individual policy checks so both the compliance
// scanner AND the AI policy self-consistency validator
// (app/lib/policy-validator.server.ts) read from the same source. Edits
// here flow to both — intentional coupling.

/** Refund-policy signals (refund-return-policy.server.ts). */
export const RETURN_WINDOW_RE =
  /\d+\s*(?:calendar\s+)?(?:day|week|month|year)s?(?:\s*[-–]\s*\d+\s*(?:day|week|month|year)s?)?/i;
export const ITEM_CONDITION_RE =
  /\b(?:unused|unworn|unwashed|original\s+packaging|original\s+condition|undamaged|unopened|tags\s+attached)\b/i;
export const REFUND_METHOD_RE =
  /\b(?:full\s+refund|refund|exchange|store\s+credit|replacement|credit\s+card)\b/i;

/** Shipping-policy signals (shipping-policy.server.ts). */
export const TIMELINE_RE =
  /\d+\s*(?:to|[-–])\s*\d+\s*(?:business\s+)?days?|\d+\s*(?:business\s+)?days?|within\s+\d+\s*(?:business\s+)?days?|same[\s-]day|next[\s-]day|overnight/i;
export const COST_RE =
  /free\s+shipping|flat[\s-]rate|\$\s*[\d,.]+|calculated\s+at\s+checkout|free\s+on\s+orders|shipping\s+costs?|postage|delivery\s+fee/i;

/** Placeholder-text detector (refund + privacy/terms). */
export const PLACEHOLDER_RE =
  /lorem\s+ipsum|\[your\s+(?:company|store|name)\]|\[company\s*name\]|\[insert\b/i;

export const PRIVATE_IP_PATTERNS: RegExp[] = [
  /^127\./,                          // 127.0.0.0/8  — IPv4 loopback
  /^10\./,                           // 10.0.0.0/8   — RFC1918 private
  /^172\.(1[6-9]|2\d|3[01])\./,     // 172.16.0.0/12 — RFC1918 private
  /^192\.168\./,                     // 192.168.0.0/16 — RFC1918 private
  /^169\.254\./,                     // 169.254.0.0/16 — link-local (AWS metadata)
  /^0\.0\.0\.0$/,                    // unspecified
  /^::1$/,                           // IPv6 loopback
  /^fc[0-9a-f]{2}:/i,               // IPv6 unique local fc00::/7
  /^fd[0-9a-f]{2}:/i,               // IPv6 unique local fd00::/8
];

export const PAYMENT_KEYWORDS = [
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

export const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "in", "on", "at", "to", "for",
  "by", "with", "my", "your", "our", "this", "it", "is", "are", "be",
  // Business suffixes that carry no brand identity signal
  "inc", "llc", "ltd", "co", "corp", "shop", "store", "online", "official",
  "brand", "brands", "boutique", "company", "group",
]);
