/**
 * app/lib/shopify-api.server.ts
 *
 * Public API barrel file for the Shopify GraphQL Admin API service layer.
 *
 * Re-exports all types, queries, and client infrastructure from the split
 * modules so that existing consumers continue to work without import changes.
 *
 * Data functions (getShopInfo, getShopPolicies, getProducts, getPages) live
 * here since they depend on both the query documents and the client infra.
 *
 * Supports two execution modes:
 *
 *   1. Interactive (route loaders/actions):
 *        const { admin } = await authenticate.admin(request);
 *        const executor = wrapAdminClient(admin.graphql);
 *        const info = await getShopInfo(executor);
 *
 *   2. Background / automated scanner (no HTTP request context):
 *        const executor = await createAdminClient("mystore.myshopify.com");
 *        const products = await getProducts(executor);
 */

// Re-export everything from the split modules so existing consumers are unaffected.
export {
  // Types — Business domain
  type BillingAddress,
  type PrimaryDomain,
  type ShopInfo,
  type ShopPolicyType,
  type ShopPolicy,
  type ShopPoliciesResult,
  type ProductImage,
  type ProductVariant,
  type Product,
  type Page,
  // Query documents
  SHOP_INFO_QUERY,
  SHOP_POLICIES_QUERY,
  PRODUCTS_QUERY,
  PAGES_QUERY,
} from "./graphql-queries.server";

export {
  // Constants
  SHOPIFY_API_VERSION,
  MAX_RETRIES,
  BASE_RETRY_DELAY_MS,
  // Types — GraphQL infrastructure
  type ShopifyGQLError,
  type ThrottleStatus,
  type CostInfo,
  type GQLResponse,
  type GraphQLExecutor,
  type AdminGraphqlFn,
  // Executor factories
  wrapAdminClient,
  createAdminClient,
  // Retry logic
  executeWithRetry,
} from "./graphql-client.server";

// ─────────────────────────────────────────────────────────────────────────────
// Imports used by the data functions below
// ─────────────────────────────────────────────────────────────────────────────

import type { GraphQLExecutor } from "./graphql-client.server";
import { executeWithRetry } from "./graphql-client.server";
import {
  SHOP_INFO_QUERY,
  SHOP_POLICIES_QUERY,
  PRODUCTS_QUERY,
  PAGES_QUERY,
  type ShopInfo,
  type ShopPolicyType,
  type ShopPolicy,
  type ShopPoliciesResult,
  type Product,
  type Page,
} from "./graphql-queries.server";

// ─────────────────────────────────────────────────────────────────────────────
// Public Data Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetches core shop metadata needed for compliance scanning.
 *
 * Returns null if the request fails — callers should treat null as a signal
 * that the scan cannot proceed (e.g. revoked token, network failure).
 */
export async function getShopInfo(
  executor: GraphQLExecutor
): Promise<ShopInfo | null> {
  try {
    interface RawShopInfo {
      shop: {
        name: string;
        contactEmail: string;
        billingAddress: {
          address1: string | null;
          city: string | null;
          province: string | null;
          country: string | null;
          zip: string | null;
        } | null;
        myshopifyDomain: string;
        currencyCode: string;
        primaryDomain: { url: string; host: string };
      };
    }

    const result = await executeWithRetry<RawShopInfo>(
      executor,
      "getShopInfo",
      SHOP_INFO_QUERY
    );

    if (result.errors?.length) {
      console.error(
        "[ShopifyAPI] getShopInfo GraphQL errors:",
        JSON.stringify(result.errors, null, 2)
      );
    }

    const shop = result.data?.shop;
    if (!shop) return null;

    return {
      name: shop.name,
      contactEmail: shop.contactEmail,
      billingAddress: {
        address1: shop.billingAddress?.address1 ?? null,
        city: shop.billingAddress?.city ?? null,
        province: shop.billingAddress?.province ?? null,
        country: shop.billingAddress?.country ?? null,
        zip: shop.billingAddress?.zip ?? null,
      },
      myshopifyDomain: shop.myshopifyDomain,
      currencyCode: shop.currencyCode,
      primaryDomain: {
        url: shop.primaryDomain.url,
        host: shop.primaryDomain.host,
      },
    };
  } catch (err) {
    console.error("[ShopifyAPI] getShopInfo unexpected error:", err);
    return null;
  }
}

/**
 * Fetches all shop policies (refund, privacy, terms, shipping).
 *
 * Each known policy type is always present in the result — as either a
 * ShopPolicy object or null. This allows the scanner to distinguish between
 * "policy exists but has no body" and "policy is completely missing", which
 * is itself a compliance violation.
 */
export async function getShopPolicies(
  executor: GraphQLExecutor
): Promise<ShopPoliciesResult> {
  const empty: ShopPoliciesResult = {
    REFUND_POLICY: null,
    PRIVACY_POLICY: null,
    TERMS_OF_SERVICE: null,
    SHIPPING_POLICY: null,
    all: [],
  };

  try {
    // shopPolicies moved from QueryRoot to shop{} in API 2024-10+.
    interface RawPolicies {
      shop: {
        shopPolicies: Array<{
          type: string;
          title: string;
          url: string | null;
          body: string;
        }>;
      };
    }

    const result = await executeWithRetry<RawPolicies>(
      executor,
      "getShopPolicies",
      SHOP_POLICIES_QUERY
    );

    if (result.errors?.length) {
      console.error(
        "[ShopifyAPI] getShopPolicies GraphQL errors:",
        JSON.stringify(result.errors, null, 2)
      );
    }

    const rawPolicies = result.data?.shop?.shopPolicies ?? [];

    const policies: ShopPolicy[] = rawPolicies.map((p) => ({
      type: p.type as ShopPolicyType,
      title: p.title,
      url: p.url ?? "",
      body: p.body,
    }));

    // Build a keyed map so missing policy types default to null.
    const byType = Object.fromEntries(
      policies.map((p) => [p.type, p])
    ) as Partial<Record<ShopPolicyType, ShopPolicy>>;

    return {
      REFUND_POLICY:    byType.REFUND_POLICY    ?? null,
      PRIVACY_POLICY:   byType.PRIVACY_POLICY   ?? null,
      TERMS_OF_SERVICE: byType.TERMS_OF_SERVICE ?? null,
      SHIPPING_POLICY:  byType.SHIPPING_POLICY  ?? null,
      all: policies,
    };
  } catch (err) {
    console.error("[ShopifyAPI] getShopPolicies unexpected error:", err);
    return empty;
  }
}

/**
 * Fetches products with their images and variants using cursor-based pagination.
 *
 * Returns an empty array on any failure so the scanner can still run partial
 * checks against other data sources.
 *
 * @param executor GraphQL executor
 * @param maxTotal Maximum total products to fetch. Default 250.
 */
export async function getProducts(
  executor: GraphQLExecutor,
  maxTotal = 250
): Promise<Product[]> {
  const PAGE_SIZE = 50;

  try {
    interface RawProducts {
      products: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        edges: Array<{
          node: {
            title: string;
            description: string;
            descriptionHtml: string;
            handle: string;
            onlineStoreUrl: string | null;
            images: {
              edges: Array<{ node: { url: string; altText: string | null } }>;
            };
            variants: {
              edges: Array<{
                node: {
                  price: string;
                  compareAtPrice: string | null;
                  inventoryQuantity: number | null;
                  sku: string | null;
                  barcode: string | null;
                };
              }>;
            };
          };
        }>;
      };
    }

    const allProducts: Product[] = [];
    let cursor: string | null = null;

    while (allProducts.length < maxTotal) {
      const variables: { first: number; after: string | null } = {
        first: Math.min(PAGE_SIZE, maxTotal - allProducts.length),
        after: cursor,
      };
      const result = await executeWithRetry<RawProducts>(
        executor,
        "getProducts",
        PRODUCTS_QUERY,
        variables
      );

      if (result.errors?.length) {
        console.error(
          "[ShopifyAPI] getProducts GraphQL errors:",
          JSON.stringify(result.errors, null, 2)
        );
      }

      const edges = result.data?.products?.edges ?? [];
      const pageInfo: RawProducts["products"]["pageInfo"] | undefined =
        result.data?.products?.pageInfo;

      for (const { node } of edges) {
        allProducts.push({
          title: node.title,
          description: node.description,
          descriptionHtml: node.descriptionHtml,
          handle: node.handle,
          onlineStoreUrl: node.onlineStoreUrl ?? null,
          images: node.images.edges.map(({ node: img }) => ({
            url: img.url,
            altText: img.altText ?? null,
          })),
          variants: node.variants.edges.map(({ node: v }) => ({
            price: v.price,
            compareAtPrice: v.compareAtPrice ?? null,
            inventoryQuantity: v.inventoryQuantity ?? null,
            sku: v.sku ?? null,
            barcode: v.barcode ?? null,
          })),
        });
      }

      if (!pageInfo?.hasNextPage || allProducts.length >= maxTotal) break;
      cursor = pageInfo.endCursor;
    }

    return allProducts;
  } catch (err) {
    console.error("[ShopifyAPI] getProducts unexpected error:", err);
    return [];
  }
}

/**
 * Fetches online store pages (About, FAQ, etc.) using cursor-based pagination.
 *
 * Returns an empty array on any failure. The `url` field is always null because
 * `onlineStoreUrl` was removed from the Page type in API 2025-10.
 *
 * @param executor GraphQL executor
 * @param maxTotal Maximum total pages to fetch. Default 100.
 */
export async function getPages(
  executor: GraphQLExecutor,
  maxTotal = 100
): Promise<Page[]> {
  const PAGE_SIZE = 50;

  try {
    interface RawPages {
      pages: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        edges: Array<{
          node: {
            title: string;
            body: string;
            handle: string;
          };
        }>;
      };
    }

    const allPages: Page[] = [];
    let cursor: string | null = null;

    while (allPages.length < maxTotal) {
      const variables: { first: number; after: string | null } = {
        first: Math.min(PAGE_SIZE, maxTotal - allPages.length),
        after: cursor,
      };
      const result = await executeWithRetry<RawPages>(
        executor,
        "getPages",
        PAGES_QUERY,
        variables
      );

      if (result.errors?.length) {
        console.error(
          "[ShopifyAPI] getPages GraphQL errors:",
          JSON.stringify(result.errors, null, 2)
        );
      }

      const edges = result.data?.pages?.edges ?? [];
      const pageInfo: RawPages["pages"]["pageInfo"] | undefined =
        result.data?.pages?.pageInfo;

      for (const { node } of edges) {
        allPages.push({
          title: node.title,
          body: node.body,
          handle: node.handle,
          url: null, // onlineStoreUrl removed from Page type in API 2025-10
        });
      }

      if (!pageInfo?.hasNextPage || allPages.length >= maxTotal) break;
      cursor = pageInfo.endCursor;
    }

    return allPages;
  } catch (err) {
    console.error("[ShopifyAPI] getPages unexpected error:", err);
    return [];
  }
}
