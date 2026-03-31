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
