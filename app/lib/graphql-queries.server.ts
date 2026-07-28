/**
 * app/lib/graphql-queries.server.ts
 *
 * GraphQL query documents and their associated response/domain types for the
 * Shopify Admin API. Extracted from shopify-api.server.ts for modularity.
 */

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
  shopOwnerName: string | null;
  ianaTimezone: string | null;
  createdAt: string | null;
  plan: {
    displayName: string | null;
    shopifyPlus: boolean | null;
    partnerDevelopment: boolean | null;
  };
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
  /**
   * FALSE when the Admin API call did not yield a usable answer — a throw, or
   * GraphQL errors with no data (e.g. THROTTLED, or a 401 from a lapsed offline
   * token). Distinguishes "this shop has no policies" from "we could not read
   * this shop's policies", which are the same shape but opposite meanings.
   *
   * Added 2026-07-28 after a post-mortem: `getShopPolicies()` returned an
   * all-null result on failure, and the four policy checks read that as
   * "missing", reporting FOUR criticals on stores that were fine. Three paying
   * merchants saw their score flip between 91.67 and 58.33 — once 94 minutes
   * apart — and churned. `critical_count = 4` was the only bucket in the whole
   * scans table that co-occurred with `shop_info_unavailable` (9/17; 0 of 98
   * everywhere else).
   *
   * RULE: never report a compliance failure derived from a fetch that failed.
   * Callers must degrade to a non-scorable info result when this is false.
   */
  available: boolean;
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
// GraphQL Query Documents
// ─────────────────────────────────────────────────────────────────────────────

export const SHOP_INFO_QUERY = /* GraphQL */ `
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
      shopOwnerName
      ianaTimezone
      createdAt
      plan {
        displayName
        shopifyPlus
        partnerDevelopment
      }
    }
  }
`;

export const SHOP_POLICIES_QUERY = /* GraphQL */ `
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

export const PRODUCTS_QUERY = /* GraphQL */ `
  query ShieldKitProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
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

export const PAGES_QUERY = /* GraphQL */ `
  query ShieldKitPages($first: Int!, $after: String) {
    pages(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
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
