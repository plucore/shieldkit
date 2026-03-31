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
function logCost(_queryName: string, _cost: CostInfo | undefined): void {
  // Intentionally silent — enable for local debugging if needed.
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
 * Reads the access token from the **sessions** table first (always fresh —
 * updated by SupabaseSessionStorage.storeSession() on every authenticate.admin()
 * call and token rotation). Falls back to the merchants table's
 * access_token_encrypted column if no offline session is found.
 *
 * Throws if neither source has a usable access token.
 *
 * @example
 *   const executor = await createAdminClient("mystore.myshopify.com");
 *   const products = await getProducts(executor);
 */
export async function createAdminClient(
  shopDomain: string
): Promise<GraphQLExecutor> {
  let accessToken: string | null = null;

  // ── Primary: read from sessions table (always fresh) ────────────────────
  const { data: sessionRow, error: sessionError } = await supabase
    .from("sessions")
    .select("access_token")
    .eq("shop", shopDomain)
    .eq("is_online", false)
    .order("expires", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  if (sessionError) {
    console.error(
      `[ShopifyAPI] createAdminClient: session lookup failed for ${shopDomain}: ${sessionError.message}`
    );
  }

  if (sessionRow?.access_token) {
    try {
      accessToken = decrypt(sessionRow.access_token);
    } catch (e) {
      console.error(
        `[ShopifyAPI] createAdminClient: failed to decrypt session token for ${shopDomain}:`,
        e
      );
    }
  }

  // ── Fallback: read from merchants table ─────────────────────────────────
  if (!accessToken) {
    const { data: merchant, error: merchantError } = await supabase
      .from("merchants")
      .select("access_token_encrypted")
      .eq("shopify_domain", shopDomain)
      .maybeSingle();

    if (merchantError) {
      throw new Error(
        `[ShopifyAPI] createAdminClient: Supabase lookup failed for ${shopDomain}: ${merchantError.message}`
      );
    }

    if (merchant?.access_token_encrypted) {
      try {
        accessToken = decrypt(merchant.access_token_encrypted);
      } catch (e) {
        console.error(
          `[ShopifyAPI] createAdminClient: failed to decrypt merchant token for ${shopDomain}:`,
          e
        );
      }
    }
  }

  if (!accessToken) {
    throw new Error(
      `[ShopifyAPI] createAdminClient: No access token found for ${shopDomain}. ` +
        `Is the app installed and the merchant record populated?`
    );
  }

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
