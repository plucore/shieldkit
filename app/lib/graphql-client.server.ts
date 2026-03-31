/**
 * app/lib/graphql-client.server.ts
 *
 * GraphQL client infrastructure for the Shopify Admin API. Provides two
 * executor factories (interactive and background) plus retry logic with
 * exponential backoff on THROTTLED errors.
 *
 * Extracted from shopify-api.server.ts for modularity.
 */

import { supabase } from "../supabase.server";
import { decrypt } from "./crypto.server";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Shopify Admin API version used for all raw background requests. */
export const SHOPIFY_API_VERSION = "2025-10";

/** Maximum number of retry attempts when a THROTTLED error is returned. */
export const MAX_RETRIES = 3;

/** Base delay (ms) for exponential backoff: 500 → 1000 → 2000. */
export const BASE_RETRY_DELAY_MS = 500;

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

export async function executeWithRetry<T>(
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
