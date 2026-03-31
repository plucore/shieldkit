/**
 * app/lib/checks/constants.ts
 *
 * Constants shared across compliance check functions.
 */

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
