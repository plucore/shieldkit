/**
 * app/lib/enrichment/gtin-enrichment.server.ts
 *
 * Phase 7.1 — Per-product GTIN/MPN/brand metafield enricher.
 *
 * Used by:
 *   - app/routes/webhooks.products.update.tsx (continuous enrichment on
 *     products/create + products/update)
 *
 * The bulk route (app/routes/app.gtin-fill.tsx) deliberately keeps its
 * own batched mutation pipeline so its behavior stays identical to v1.
 * Both call sites write the same metafield namespace/keys/types.
 *
 * Returns a structured result the webhook persists to enrichment_webhook_log.
 */

import {
  decideEnrichment,
  needsShopNameFallback,
  type EnrichmentSnapshot,
} from "./enrichment-decision.server";

export interface EnrichmentResult {
  ok: boolean;
  written: string[];
  skipped: string[];
  error?: string;
}

interface AdminLike {
  graphql: (
    query: string,
    opts?: { variables?: Record<string, unknown> },
  ) => Promise<{ json: () => Promise<unknown> }>;
}

const PRODUCT_QUERY = `#graphql
  query ProductForEnrichment($id: ID!) {
    product(id: $id) {
      id
      title
      vendor
      variants(first: 1) {
        edges { node { sku barcode } }
      }
      metafields(namespace: "custom", first: 10) {
        edges { node { key value } }
      }
    }
  }
`;

const SHOP_QUERY = `#graphql
  query ShopName { shop { name } }
`;

const METAFIELDS_SET = `#graphql
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id key namespace }
      userErrors { field message }
    }
  }
`;

interface ProductPayload {
  id: string;
  title: string;
  vendor: string | null;
  variants: { edges: Array<{ node: { sku: string | null; barcode: string | null } }> };
  metafields: { edges: Array<{ node: { key: string; value: string } }> };
}

/**
 * Enrich a single product's GTIN/MPN/brand metafields.
 *
 * Skips any field already populated, and skips writing GTIN when the
 * variant has no barcode signal (likewise MPN when no SKU). Brand falls
 * back to shop.name when product.vendor is empty.
 */
export async function enrichProductMetafields(
  admin: AdminLike,
  productGid: string,
): Promise<EnrichmentResult> {
  try {
    const res = await admin.graphql(PRODUCT_QUERY, { variables: { id: productGid } });
    const json = (await res.json()) as { data?: { product: ProductPayload | null } };
    const product = json?.data?.product;
    if (!product) {
      return { ok: false, written: [], skipped: [], error: "product_not_found" };
    }

    // Normalise the edges shape this query returns into the shared snapshot the
    // paged reconcile also builds, then run the SINGLE shared decision function.
    // Both discovery paths must reach identical conclusions or the Block 4 parity
    // gate is meaningless — see enrichment-decision.server.ts.
    const variant = product.variants.edges[0]?.node;
    const existing: Record<string, string> = {};
    for (const { node: m } of product.metafields.edges) existing[m.key] = m.value;
    const snap: EnrichmentSnapshot = {
      productGid,
      vendor: product.vendor ?? null,
      sku: variant?.sku ?? null,
      barcode: variant?.barcode ?? null,
      existing,
    };

    // Lazily resolve the last-resort brand fallback: one extra query, and only
    // for products that actually need it.
    let shopName: string | null = null;
    if (needsShopNameFallback(snap)) {
      try {
        const shopRes = await admin.graphql(SHOP_QUERY);
        const shopJson = (await shopRes.json()) as { data?: { shop?: { name?: string } } };
        shopName = shopJson?.data?.shop?.name ?? null;
      } catch {
        shopName = null;
      }
    }

    const decision = decideEnrichment(snap, shopName);
    const skipped = decision.skipped;
    if (decision.optedOut) {
      return { ok: true, written: [], skipped };
    }

    const written = decision.writes.map((w) => w.key);
    const inputs = decision.writes.map((w) => ({
      ownerId: productGid,
      namespace: "custom",
      key: w.key,
      type: "single_line_text_field",
      value: w.value,
    }));

    if (inputs.length === 0) {
      return { ok: true, written: [], skipped };
    }

    const mutRes = await admin.graphql(METAFIELDS_SET, { variables: { metafields: inputs } });
    const mutJson = (await mutRes.json()) as {
      data?: { metafieldsSet?: { userErrors?: Array<{ field: string[] | null; message: string }> } };
    };
    const userErrors = mutJson?.data?.metafieldsSet?.userErrors ?? [];
    if (userErrors.length > 0) {
      return {
        ok: false,
        written: [],
        skipped,
        error: userErrors.map((u) => u.message).join("; ").slice(0, 500),
      };
    }

    return { ok: true, written, skipped };
  } catch (err) {
    return {
      ok: false,
      written: [],
      skipped: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Convenience: extract numeric product id from a Shopify gid like
 * `gid://shopify/Product/12345`. Returns null if the input doesn't match.
 */
export function gidToNumericId(gid: string): string | null {
  const m = gid.match(/\/(\d+)$/);
  return m ? m[1] : null;
}
