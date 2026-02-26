/**
 * app/lib/shopify-api.server.ts
 *
 * Server-side Shopify GraphQL Admin API service layer for ShieldKit.
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
 *
 * Both modes normalise to the same GraphQLExecutor type so all data functions
 * work identically regardless of how the client was obtained.
 */

import { supabase } from "../supabase.server";
import { decrypt } from "./crypto.server";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Shopify Admin API version used for all raw background requests. */
const SHOPIFY_API_VERSION = "2025-10";

/** Maximum number of retry attempts when a THROTTLED error is returned. */
const MAX_RETRIES = 3;

/** Base delay (ms) for exponential backoff: 500 → 1000 → 2000. */
const BASE_RETRY_DELAY_MS = 500;

// ─────────────────────────────────────────────────────────────────────────────
// Types — GraphQL infrastructure
// ─────────────────────────────────────────────────────────────────────────────

export interface ShopifyGQLError {
  message: string;
  locations?: { line: number; column: number }[];
  path?: string[];
  extensions?: {
    code?: string;
    requestedQueryCost?: number;
    availableQueryCost?: number;
    documentation?: string;
  };
}

export interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

export interface CostInfo {
  requestedQueryCost: number;
  actualQueryCost: number;
  throttleStatus: ThrottleStatus;
}

export interface GQLResponse<T = Record<string, unknown>> {
  data: T | null;
  errors?: ShopifyGQLError[];
  extensions?: {
    cost?: CostInfo;
  };
}

/**
 * Normalised async function that executes a GraphQL query against the Shopify
 * Admin API. Both wrapAdminClient() and createAdminClient() produce this type
 * so all data functions are agnostic to how the client was obtained.
 */
export type GraphQLExecutor = <T = Record<string, unknown>>(
  query: string,
  variables?: Record<string, unknown>
) => Promise<GQLResponse<T>>;

/**
 * The signature of admin.graphql from @shopify/shopify-app-react-router.
 * It returns a ResponseWithType — a Fetch Response with a typed .json() method.
 * Callers must await .json() to get the parsed GraphQL body.
 */
export type AdminGraphqlFn = (
  query: string,
  options?: { variables?: Record<string, unknown> }
) => Promise<{ json(): Promise<unknown>; ok: boolean; status: number }>;

// ─────────────────────────────────────────────────────────────────────────────
// Types — Business domain
// ─────────────────────────────────────────────────────────────────────────────

export interface BillingAddress {
  address1: string | null;
  city: string | null;
  province: string | null;
  country: string | null;
  zip: string | null;
}

export interface PrimaryDomain {
  url: string;
  host: string;
}

export interface ShopInfo {
  name: string;
  contactEmail: string;
  billingAddress: BillingAddress;
  myshopifyDomain: string;
  currencyCode: string;
  primaryDomain: PrimaryDomain;
}

export type ShopPolicyType =
  | "REFUND_POLICY"
  | "PRIVACY_POLICY"
  | "TERMS_OF_SERVICE"
  | "SHIPPING_POLICY";

export interface ShopPolicy {
  type: ShopPolicyType;
  title: string;
  url: string;
  body: string;
}

/**
 * Return type for getShopPolicies(). Each known policy type is either present
 * or explicitly null — never omitted — so callers can check membership easily.
 */
export interface ShopPoliciesResult {
  REFUND_POLICY: ShopPolicy | null;
  PRIVACY_POLICY: ShopPolicy | null;
  TERMS_OF_SERVICE: ShopPolicy | null;
  SHIPPING_POLICY: ShopPolicy | null;
  /** All policy objects that Shopify actually returned (useful for iteration). */
  all: ShopPolicy[];
}

export interface ProductImage {
  url: string;
  altText: string | null;
}

export interface ProductVariant {
  price: string;
  compareAtPrice: string | null;
  inventoryQuantity: number | null;
  sku: string | null;
  barcode: string | null;
}

export interface Product {
  title: string;
  description: string;
  descriptionHtml: string;
  handle: string;
  onlineStoreUrl: string | null;
  images: ProductImage[];
  variants: ProductVariant[];
}

export interface Page {
  title: string;
  body: string;
  handle: string;
  /** Maps to onlineStoreUrl from the API (null if the page is not published). */
  url: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isThrottled(response: GQLResponse<unknown>): boolean {
  return (
    response.errors?.some((e) => e.extensions?.code === "THROTTLED") ?? false
  );
}

/**
 * Logs query cost and remaining query budget to the console after every
 * successful response. Helps identify expensive queries before they cause
 * throttling in production.
 */
function logCost(queryName: string, cost: CostInfo | undefined): void {
  if (!cost) return;
  const { actualQueryCost, requestedQueryCost, throttleStatus } = cost;
  console.log(
    `[ShopifyAPI] ${queryName} — ` +
      `cost: ${actualQueryCost} (requested: ${requestedQueryCost}) | ` +
      `remaining: ${throttleStatus.currentlyAvailable}/${throttleStatus.maximumAvailable} ` +
      `(restores ${throttleStatus.restoreRate}/s)`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Executor Factories
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wraps the library's admin.graphql function into a normalised GraphQLExecutor.
 *
 * Use this inside route loaders and actions after authenticate.admin(request).
 *
 * @example
 *   const { admin } = await authenticate.admin(request);
 *   const executor = wrapAdminClient(admin.graphql);
 *   const shopInfo = await getShopInfo(executor);
 */
export function wrapAdminClient(adminGraphql: AdminGraphqlFn): GraphQLExecutor {
  return async <T = Record<string, unknown>>(
    query: string,
    variables?: Record<string, unknown>
  ): Promise<GQLResponse<T>> => {
    const response = await adminGraphql(query, { variables: variables ?? {} });
    // response is ResponseWithType — always call .json() to get the body.
    const body = await response.json();
    return body as GQLResponse<T>;
  };
}

/**
 * Creates a GraphQLExecutor for background jobs and automated scans where no
 * HTTP request context is available.
 *
 * Looks up the merchant's AES-256-GCM encrypted access token from the
 * Supabase `merchants` table, decrypts it, and constructs an executor that
 * makes raw fetch calls to the Shopify Admin GraphQL API.
 *
 * Throws if the merchant is not found or has no stored access token.
 *
 * @example
 *   const executor = await createAdminClient("mystore.myshopify.com");
 *   const products = await getProducts(executor);
 */
export async function createAdminClient(
  shopDomain: string
): Promise<GraphQLExecutor> {
  const { data: merchant, error } = await supabase
    .from("merchants")
    .select("access_token_encrypted, shopify_domain")
    .eq("shopify_domain", shopDomain)
    .maybeSingle();

  if (error) {
    throw new Error(
      `[ShopifyAPI] createAdminClient: Supabase lookup failed for ${shopDomain}: ${error.message}`
    );
  }

  if (!merchant?.access_token_encrypted) {
    throw new Error(
      `[ShopifyAPI] createAdminClient: No access token found for ${shopDomain}. ` +
        `Is the app installed and the merchant record populated?`
    );
  }

  const accessToken = decrypt(merchant.access_token_encrypted);
  const endpoint = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  return async <T = Record<string, unknown>>(
    query: string,
    variables?: Record<string, unknown>
  ): Promise<GQLResponse<T>> => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables: variables ?? {} }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `[ShopifyAPI] HTTP ${response.status} from ${shopDomain}: ${text.slice(0, 300)}`
      );
    }

    return response.json() as Promise<GQLResponse<T>>;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Core: executeWithRetry
//
// Wraps any GraphQL call with exponential backoff on THROTTLED errors.
// All public data functions route through this to ensure consistent rate-limit
// handling and cost logging across both executor modes.
// ─────────────────────────────────────────────────────────────────────────────

async function executeWithRetry<T>(
  executor: GraphQLExecutor,
  queryName: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<GQLResponse<T>> {
  let attempt = 0;

  for (;;) {
    const result = await executor<T>(query, variables);

    // Log query cost on every response (non-throttled and throttled alike).
    logCost(queryName, result.extensions?.cost);

    if (!isThrottled(result)) {
      return result;
    }

    if (attempt >= MAX_RETRIES) {
      console.error(
        `[ShopifyAPI] ${queryName} still throttled after ${MAX_RETRIES} retries. ` +
          `Returning throttled response to caller.`
      );
      return result;
    }

    // Exponential backoff: 500ms → 1000ms → 2000ms
    const delayMs = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
    const available =
      result.errors?.find((e) => e.extensions?.code === "THROTTLED")
        ?.extensions?.availableQueryCost ?? "unknown";
    console.warn(
      `[ShopifyAPI] ${queryName} throttled (available cost: ${available}). ` +
        `Retry ${attempt + 1}/${MAX_RETRIES} in ${delayMs}ms...`
    );

    await sleep(delayMs);
    attempt++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GraphQL Query Documents
// ─────────────────────────────────────────────────────────────────────────────

const SHOP_INFO_QUERY = /* GraphQL */ `
  query ShieldKitShopInfo {
    shop {
      name
      contactEmail
      billingAddress {
        address1
        city
        province
        country
        zip
      }
      myshopifyDomain
      currencyCode
      primaryDomain {
        url
        host
      }
    }
  }
`;

const SHOP_POLICIES_QUERY = /* GraphQL */ `
  query ShieldKitShopPolicies {
    shop {
      shopPolicies {
        type
        title
        url
        body
      }
    }
  }
`;

const PRODUCTS_QUERY = /* GraphQL */ `
  query ShieldKitProducts($first: Int!) {
    products(first: $first) {
      edges {
        node {
          title
          description
          descriptionHtml
          handle
          onlineStoreUrl
          images(first: 5) {
            edges {
              node {
                url
                altText
              }
            }
          }
          variants(first: 10) {
            edges {
              node {
                price
                compareAtPrice
                inventoryQuantity
                sku
                barcode
              }
            }
          }
        }
      }
    }
  }
`;

const PAGES_QUERY = /* GraphQL */ `
  query ShieldKitPages($first: Int!) {
    pages(first: $first) {
      edges {
        node {
          title
          body
          handle
        }
      }
    }
  }
`;

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
 * Fetches products with their images and variants.
 *
 * Returns an empty array on any failure so the scanner can still run partial
 * checks against other data sources.
 *
 * @param first Number of products to fetch. Default 50. Shopify max is 250.
 */
export async function getProducts(
  executor: GraphQLExecutor,
  first = 50
): Promise<Product[]> {
  try {
    interface RawProducts {
      products: {
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

    const result = await executeWithRetry<RawProducts>(
      executor,
      "getProducts",
      PRODUCTS_QUERY,
      { first }
    );

    if (result.errors?.length) {
      console.error(
        "[ShopifyAPI] getProducts GraphQL errors:",
        JSON.stringify(result.errors, null, 2)
      );
    }

    const edges = result.data?.products?.edges ?? [];

    return edges.map(({ node }): Product => ({
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
    }));
  } catch (err) {
    console.error("[ShopifyAPI] getProducts unexpected error:", err);
    return [];
  }
}

/**
 * Fetches online store pages (About, FAQ, etc.).
 *
 * Returns an empty array on any failure. The `url` field maps to Shopify's
 * `onlineStoreUrl` and is null if the page is not published to the storefront.
 *
 * @param first Number of pages to fetch. Default 20. Shopify max is 250.
 */
export async function getPages(
  executor: GraphQLExecutor,
  first = 20
): Promise<Page[]> {
  try {
    // onlineStoreUrl was removed from the Page type in API 2025-10.
    interface RawPages {
      pages: {
        edges: Array<{
          node: {
            title: string;
            body: string;
            handle: string;
          };
        }>;
      };
    }

    const result = await executeWithRetry<RawPages>(
      executor,
      "getPages",
      PAGES_QUERY,
      { first }
    );

    if (result.errors?.length) {
      console.error(
        "[ShopifyAPI] getPages GraphQL errors:",
        JSON.stringify(result.errors, null, 2)
      );
    }

    const edges = result.data?.pages?.edges ?? [];

    return edges.map(({ node }): Page => ({
      title: node.title,
      body: node.body,
      handle: node.handle,
      url: null, // onlineStoreUrl removed from Page type in API 2025-10
    }));
  } catch (err) {
    console.error("[ShopifyAPI] getPages unexpected error:", err);
    return [];
  }
}
