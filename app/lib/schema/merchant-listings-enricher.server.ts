/**
 * app/lib/schema/merchant-listings-enricher.server.ts
 *
 * Phase 5.1 — builds a Google Merchant Listings Markup compliant Product
 * JSON-LD object for a given Shopify product. Adds gtin / mpn / brand,
 * MerchantReturnPolicy, OfferShippingDetails, and optional aggregateRating.
 *
 * The fields gtin / mpn / brand are pulled from product metafields when
 * present (filled by the Auto-Filler in Phase 5.2). When missing the field
 * is omitted from the output rather than emitting an empty string, which
 * Google's Merchant Listings validator treats more leniently than empty.
 *
 * Status: SKELETON. The function compiles and produces a valid object today
 * for products that already have raw fields populated, but the read paths
 * for metafields, return policy, and shipping zones require:
 *   - read_themes scope (for the theme JSON-LD injection — Phase 5.1 deploy)
 *   - write_products scope (for Auto-Filler writes — Phase 5.2)
 *   - read_shipping + read_locations scopes (for OfferShippingDetails)
 *
 * Until those scopes ship, callers should fall back to the existing
 * Product JSON-LD block in the theme extension.
 */

import type { Product } from "../graphql-queries.server";

export interface MerchantListingsInput {
  product: Product;
  shopName: string;
  storeUrl: string; // e.g. "https://mystore.com"
  productUrl: string | null; // null when the product isn't published
  /**
   * Metafield bag, expected shape `{ "custom.gtin": "...", "custom.mpn": "...", "custom.brand": "...", "custom.identifier_exists": "false" }`.
   * Filled by app.gtin-fill.tsx (Phase 5.2). Empty object until the Auto-Filler ships.
   */
  metafields: Record<string, string | null>;
  /**
   * Refund policy summary derived from getShopPolicies() — return window in days,
   * applicable category, return method. Optional; omitted when absent.
   */
  returnPolicy?: {
    returnWindowDays?: number;
    applicableCountry?: string;
    returnMethod?: "ByMail" | "InStore" | "KeepProduct";
    returnFees?: "FreeReturn" | "ReturnFeesCustomerResponsibility";
  };
  /**
   * Shipping rates from Shopify's shipping zones. Phase 5 needs read_shipping
   * + read_locations scopes — until those ship, this stays undefined and the
   * OfferShippingDetails block is omitted.
   */
  shippingRates?: Array<{
    /** ISO 3166-1 alpha-2 e.g. "US" */
    country: string;
    minTransitDays: number;
    maxTransitDays: number;
    rate: number; // 0 = free
    currency: string;
  }>;
  /**
   * Aggregate rating from a connected reviews app. Optional and merchant-opt-in.
   * Phase 5 will surface a toggle on /app/pro-settings; until then this stays
   * undefined.
   */
  aggregateRating?: {
    ratingValue: number; // 0-5
    reviewCount: number;
  };
}

/**
 * Builds a Merchant Listings-compliant Product schema object.
 * Returns null if the product is missing the required `name` or `image`
 * fields — Google rejects schemas without those, better to omit than emit
 * a broken one.
 */
export function buildMerchantListingsSchema(
  input: MerchantListingsInput,
): Record<string, unknown> | null {
  const { product, shopName, storeUrl, productUrl, metafields } = input;

  if (!product.title) return null;
  const primaryImage = product.images[0]?.url;
  if (!primaryImage) return null;

  const gtin = metafields["custom.gtin"];
  const mpn = metafields["custom.mpn"];
  const brand = metafields["custom.brand"] ?? shopName;
  const identifierExistsRaw = metafields["custom.identifier_exists"];
  const identifierExists =
    identifierExistsRaw === null || identifierExistsRaw === undefined
      ? undefined
      : identifierExistsRaw.toLowerCase() !== "false";

  const variant = product.variants[0];
  const sku = variant?.sku ?? null;
  const price = variant?.price;

  const offer: Record<string, unknown> = {
    "@type": "Offer",
    url: productUrl ?? storeUrl,
    availability:
      variant?.inventoryQuantity === null || variant?.inventoryQuantity === undefined
        ? "https://schema.org/InStock"
        : variant.inventoryQuantity > 0
          ? "https://schema.org/InStock"
          : "https://schema.org/OutOfStock",
  };
  if (price) {
    offer.price = price;
    // priceCurrency is required by GMC; the caller injects shop currency at
    // Liquid-render time. Until the theme block is wired, default to USD.
    offer.priceCurrency = "USD";
  }

  if (input.shippingRates && input.shippingRates.length > 0) {
    offer.shippingDetails = input.shippingRates.map((r) => ({
      "@type": "OfferShippingDetails",
      shippingDestination: {
        "@type": "DefinedRegion",
        addressCountry: r.country,
      },
      shippingRate: {
        "@type": "MonetaryAmount",
        value: r.rate,
        currency: r.currency,
      },
      deliveryTime: {
        "@type": "ShippingDeliveryTime",
        transitTime: {
          "@type": "QuantitativeValue",
          minValue: r.minTransitDays,
          maxValue: r.maxTransitDays,
          unitCode: "DAY",
        },
      },
    }));
  }

  if (input.returnPolicy) {
    offer.hasMerchantReturnPolicy = {
      "@type": "MerchantReturnPolicy",
      ...(input.returnPolicy.applicableCountry
        ? { applicableCountry: input.returnPolicy.applicableCountry }
        : {}),
      ...(input.returnPolicy.returnWindowDays !== undefined
        ? {
            returnPolicyCategory: "https://schema.org/MerchantReturnFiniteReturnWindow",
            merchantReturnDays: input.returnPolicy.returnWindowDays,
          }
        : {}),
      ...(input.returnPolicy.returnMethod
        ? { returnMethod: `https://schema.org/ReturnByMail` }
        : {}),
      ...(input.returnPolicy.returnFees
        ? { returnFees: `https://schema.org/${input.returnPolicy.returnFees}` }
        : {}),
    };
  }

  const schema: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.title,
    description: product.description?.slice(0, 5000) ?? product.title,
    image: primaryImage,
    brand: { "@type": "Brand", name: brand },
    offers: offer,
  };

  if (sku) schema.sku = sku;
  if (gtin) schema.gtin = gtin;
  if (mpn) schema.mpn = mpn;
  if (identifierExists === false) {
    // Tells Google "this product genuinely has no GTIN/MPN" so it stops
    // flagging Missing identifiers warnings (handmade / vintage / custom).
    (schema as Record<string, unknown>).identifier_exists = false;
  }

  if (input.aggregateRating) {
    schema.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: input.aggregateRating.ratingValue,
      reviewCount: input.aggregateRating.reviewCount,
    };
  }

  return schema;
}

/**
 * Convenience wrapper: serialise the schema as a `<script>` block ready to
 * paste into a Liquid template.
 */
export function renderSchemaScript(
  schema: Record<string, unknown> | null,
): string {
  if (!schema) return "";
  return `<script type="application/ld+json">\n${JSON.stringify(schema, null, 2)}\n</script>`;
}
