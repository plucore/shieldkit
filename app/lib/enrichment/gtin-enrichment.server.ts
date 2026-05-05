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

    const variant = product.variants.edges[0]?.node;
    const sku = variant?.sku ?? null;
    const barcode = variant?.barcode ?? null;
    const existing: Record<string, string> = {};
    for (const { node: m } of product.metafields.edges) existing[m.key] = m.value;

    // Honour explicit opt-out flag.
    if (existing["identifier_exists"] === "false") {
      return { ok: true, written: [], skipped: ["gtin", "mpn", "brand"] };
    }

    // Brand fallback: shop.name when vendor is missing.
    let brandValue: string | null = null;
    if (!existing["brand"]) {
      brandValue = product.vendor && product.vendor.length > 0 ? product.vendor : null;
      if (!brandValue) {
        try {
          const shopRes = await admin.graphql(SHOP_QUERY);
          const shopJson = (await shopRes.json()) as { data?: { shop?: { name?: string } } };
          brandValue = shopJson?.data?.shop?.name ?? null;
        } catch {
          brandValue = null;
        }
      }
    }

    type MetafieldInput = {
      ownerId: string;
      namespace: string;
      key: string;
      type: string;
      value: string;
    };
    const inputs: MetafieldInput[] = [];
    const written: string[] = [];
    const skipped: string[] = [];

    if (existing["gtin"]) {
      skipped.push("gtin");
    } else if (barcode) {
      inputs.push({ ownerId: productGid, namespace: "custom", key: "gtin", type: "single_line_text_field", value: barcode });
      written.push("gtin");
    } else {
      skipped.push("gtin");
    }

    if (existing["mpn"]) {
      skipped.push("mpn");
    } else if (sku) {
      inputs.push({ ownerId: productGid, namespace: "custom", key: "mpn", type: "single_line_text_field", value: sku });
      written.push("mpn");
    } else {
      skipped.push("mpn");
    }

    if (existing["brand"]) {
      skipped.push("brand");
    } else if (brandValue) {
      inputs.push({ ownerId: productGid, namespace: "custom", key: "brand", type: "single_line_text_field", value: brandValue });
      written.push("brand");
    } else {
      skipped.push("brand");
    }

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
