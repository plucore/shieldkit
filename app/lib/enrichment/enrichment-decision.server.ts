/**
 * app/lib/enrichment/enrichment-decision.server.ts
 *
 * The single decision function shared by BOTH enrichment discovery paths:
 *
 *   1. webhooks.products.update → drainer → enrichProductMetafields  (per-product)
 *   2. api.cron.reconcile-catalog → reconcileCatalog                 (paged, 250/page)
 *
 * WHY THIS IS EXTRACTED RATHER THAN REIMPLEMENTED. Block 4 replaces webhook
 * discovery with catalog paging, and the gate on that switch is a parity
 * comparison: does the reconcile decide the same thing the webhook path would
 * have? If each path carried its own copy of this logic, the comparison would be
 * testing two implementations against each other and any agreement would be
 * coincidence. With one function, parity reduces to a pure DISCOVERY question —
 * does paging find the same products? — which is the actual risk being gated.
 *
 * This is the same lesson as the 2026-07 scan-detector incident, where three
 * copies of the contact/payment/JSON-LD detectors drifted apart and fabricated
 * criticals. Fix enrichment decisions HERE, never per surface.
 *
 * Pure and synchronous by design: no network, no DB, no clock. The one input it
 * cannot derive locally — the shop name used as the last-resort brand fallback —
 * is passed in, and `needsShopNameFallback()` lets a caller fetch it lazily (the
 * per-product path) or once per pass (the paged path).
 */

/** Everything the decision needs about one product. */
export interface EnrichmentSnapshot {
  productGid: string;
  vendor: string | null;
  /** First variant's SKU — the MPN source. */
  sku: string | null;
  /** First variant's barcode — the GTIN source. */
  barcode: string | null;
  /** All `custom`-namespace metafields for the product, keyed. */
  existing: Record<string, string>;
}

export interface MetafieldWrite {
  key: "gtin" | "mpn" | "brand";
  value: string;
}

export interface EnrichmentDecision {
  /** Merchant set custom.identifier_exists = "false"; write nothing. */
  optedOut: boolean;
  writes: MetafieldWrite[];
  /** Keys deliberately not written, in gtin/mpn/brand order. */
  skipped: string[];
}

/**
 * True when resolving `brand` will require the shop name — i.e. brand is not
 * already set and the product has no vendor to fall back to. Lets the
 * per-product caller keep its lazy single-purpose `shop { name }` query instead
 * of paying for it on every product.
 */
export function needsShopNameFallback(snap: EnrichmentSnapshot): boolean {
  if (snap.existing["identifier_exists"] === "false") return false;
  if (snap.existing["brand"]) return false;
  return !(snap.vendor && snap.vendor.length > 0);
}

/**
 * Decide which of custom.{gtin,mpn,brand} to write for one product.
 *
 * Rules, unchanged from the original per-product enricher:
 *   - `identifier_exists === "false"` is an explicit merchant opt-out: write
 *     nothing, report all three skipped.
 *   - An already-populated key is never overwritten.
 *   - gtin needs a variant barcode; mpn needs a variant SKU. No signal → skip.
 *   - brand falls back product.metafields.custom.brand → product.vendor →
 *     shop.name. Keep in sync with the identical chain in
 *     extensions/json-ld-schema/blocks/product-schema.liquid.
 */
export function decideEnrichment(
  snap: EnrichmentSnapshot,
  shopName: string | null,
): EnrichmentDecision {
  if (snap.existing["identifier_exists"] === "false") {
    return { optedOut: true, writes: [], skipped: ["gtin", "mpn", "brand"] };
  }

  const writes: MetafieldWrite[] = [];
  const skipped: string[] = [];

  if (snap.existing["gtin"]) skipped.push("gtin");
  else if (snap.barcode) writes.push({ key: "gtin", value: snap.barcode });
  else skipped.push("gtin");

  if (snap.existing["mpn"]) skipped.push("mpn");
  else if (snap.sku) writes.push({ key: "mpn", value: snap.sku });
  else skipped.push("mpn");

  const brandValue = snap.vendor && snap.vendor.length > 0 ? snap.vendor : shopName;
  if (snap.existing["brand"]) skipped.push("brand");
  else if (brandValue) writes.push({ key: "brand", value: brandValue });
  else skipped.push("brand");

  return { optedOut: false, writes, skipped };
}

/**
 * Flatten a paged product node into a snapshot. Shared so the reconcile and any
 * future reader agree on how to read the GraphQL shape — in particular that
 * only the FIRST variant is consulted, matching the per-product enricher's
 * `variants(first: 1)`.
 */
export function snapshotFromNode(node: {
  id: string;
  vendor?: string | null;
  variants?: { nodes?: Array<{ sku?: string | null; barcode?: string | null }> | null } | null;
  metafields?: { nodes?: Array<{ key: string; value: string }> | null } | null;
}): EnrichmentSnapshot {
  const variant = node.variants?.nodes?.[0];
  const existing: Record<string, string> = {};
  for (const m of node.metafields?.nodes ?? []) existing[m.key] = m.value;
  return {
    productGid: node.id,
    vendor: node.vendor ?? null,
    sku: variant?.sku ?? null,
    barcode: variant?.barcode ?? null,
    existing,
  };
}
