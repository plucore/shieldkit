/**
 * app/lib/billing/partner-api.server.ts
 *
 * Client for the Shopify Partner API GraphQL endpoint.
 *
 * Post April 28, 2026, Shopify stops sending the APP_SUBSCRIPTIONS_UPDATE
 * webhook and the Admin API's `billing.check()` no longer returns
 * subscription status for managed-pricing apps. The Partner API becomes the
 * canonical source of truth for plan/status reconciliation.
 *
 * Partner API schema notes (important for callers):
 *
 *   - `AppSubscription` only exposes { id, name, amount, billingOn, test }.
 *     There is no `status`, no `interval`, no `lineItems`, no `createdAt`.
 *
 *   - Subscription status must be INFERRED from the most recent
 *     `AppSubscriptionEvent` for that charge:
 *       SubscriptionChargeActivated   → "active"
 *       SubscriptionChargeUnfrozen    → "active"
 *       SubscriptionChargeAccepted    → "pending"
 *       SubscriptionChargeCanceled    → "cancelled"
 *       SubscriptionChargeDeclined    → "declined"
 *       SubscriptionChargeExpired     → "expired"
 *       SubscriptionChargeFrozen      → "frozen"
 *
 *   - Billing cycle (monthly/annual) must come from the plan NAME — see
 *     PLAN_NAME_TO_CYCLE in ./plans.ts. The Partner API offers no other
 *     signal for cycle.
 *
 * Fail-safe contract: every public function in this module that returns
 * subscription state returns `{ status: "unknown", reason }` on ANY failure
 * mode (network error, GraphQL error, missing data, no matching events).
 * Callers MUST NOT demote a merchant's tier when status is "unknown".
 */

import {
  PLAN_NAME_TO_CYCLE,
  PLAN_NAME_TO_TIER,
  type PlanName,
} from "./plans";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const PARTNER_API_VERSION = "2026-04";
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 500;

const SUBSCRIPTION_EVENT_TYPES = [
  "SUBSCRIPTION_CHARGE_ACTIVATED",
  "SUBSCRIPTION_CHARGE_UNFROZEN",
  "SUBSCRIPTION_CHARGE_ACCEPTED",
  "SUBSCRIPTION_CHARGE_CANCELED",
  "SUBSCRIPTION_CHARGE_DECLINED",
  "SUBSCRIPTION_CHARGE_EXPIRED",
  "SUBSCRIPTION_CHARGE_FROZEN",
] as const;

const EVENT_TYPE_TO_STATUS: Record<string, SubscriptionStatus> = {
  SUBSCRIPTION_CHARGE_ACTIVATED: "active",
  SUBSCRIPTION_CHARGE_UNFROZEN: "active",
  SUBSCRIPTION_CHARGE_ACCEPTED: "pending",
  SUBSCRIPTION_CHARGE_CANCELED: "cancelled",
  SUBSCRIPTION_CHARGE_DECLINED: "declined",
  SUBSCRIPTION_CHARGE_EXPIRED: "expired",
  SUBSCRIPTION_CHARGE_FROZEN: "frozen",
};

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type SubscriptionStatus =
  | "active"
  | "pending"
  | "cancelled"
  | "declined"
  | "expired"
  | "frozen"
  | "unknown";

export interface PartnerActiveSubscription {
  /** Inferred from most recent AppSubscriptionEvent type. */
  status: SubscriptionStatus;
  /** Display name from Partner Dashboard config. */
  planName: string | null;
  /** Mapped via PLAN_NAME_TO_TIER. */
  tier: "free" | "shield" | "pro" | null;
  /** Derived from plan name via PLAN_NAME_TO_CYCLE (Partner API has no interval field). */
  cycle: "monthly" | "annual" | null;
  /** Full GraphQL gid, e.g. `gid://shopify/AppSubscription/12345`. */
  subscriptionGid: string | null;
  /** ISO date (YYYY-MM-DD) — when the merchant will next be billed. */
  billingOn: string | null;
  /** ISO datetime — `occurredAt` of the activating event. */
  activatedAt: string | null;
  /** Test subscription flag. */
  test: boolean | null;
  /** Populated when status === "unknown" so callers can log/diagnose. */
  reason: string | null;
}

export interface PartnerAppEvent {
  __typename: string;
  type: string;
  occurredAt: string;
  shop: { id: string; myshopifyDomain: string };
  charge?: {
    id: string;
    name: string;
    billingOn: string | null;
    amount: { amount: string; currencyCode: string };
    test: boolean;
  };
}

interface PartnerGQLResponse<T> {
  data?: T | null;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const UNKNOWN = (reason: string): PartnerActiveSubscription => ({
  status: "unknown",
  planName: null,
  tier: null,
  cycle: null,
  subscriptionGid: null,
  billingOn: null,
  activatedAt: null,
  test: null,
  reason,
});

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `[PartnerAPI] ${name} is not set. Required for Partner API queries.`,
    );
  }
  return v;
}

function partnerEndpoint(): string {
  const orgId = requireEnv("SHOPIFY_PARTNER_ORG_ID");
  return `https://partners.shopify.com/${orgId}/api/${PARTNER_API_VERSION}/graphql.json`;
}

function appGid(): string {
  // Stored as the numeric ID; we own the gid prefix to keep env values clean.
  const numericId = requireEnv("SHOPIFY_PARTNER_APP_ID");
  return `gid://partners/App/${numericId}`;
}

/**
 * Core POST + retry. Retries on network errors and 429/5xx responses with
 * exponential backoff. Does NOT retry on 4xx (other than 429) — those are
 * permanent client errors.
 *
 * Returns the parsed GraphQL body or throws. Callers wrap with try/catch
 * and convert any throw into a fail-safe "unknown" result.
 */
async function partnerApiFetch<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<PartnerGQLResponse<T>> {
  const token = requireEnv("SHOPIFY_PARTNER_API_TOKEN");
  const url = partnerEndpoint();

  let lastError: unknown = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify({ query, variables }),
      });

      if (response.status === 429 || response.status >= 500) {
        const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
        lastError = new Error(`Partner API HTTP ${response.status}`);
        if (attempt < MAX_RETRIES - 1) {
          await sleep(delay);
          continue;
        }
        throw lastError;
      }

      if (!response.ok) {
        // 4xx other than 429 — permanent, don't retry.
        const body = await response.text().catch(() => "");
        throw new Error(`Partner API HTTP ${response.status}: ${body.slice(0, 200)}`);
      }

      const body = (await response.json()) as PartnerGQLResponse<T>;
      if (body.errors && body.errors.length > 0) {
        throw new Error(
          `Partner API GraphQL errors: ${body.errors.map((e) => e.message).join("; ")}`,
        );
      }
      return body;
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES - 1) {
        await sleep(BASE_RETRY_DELAY_MS * Math.pow(2, attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastError ?? new Error("Partner API fetch exhausted retries");
}

// ─────────────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────────────

const EVENTS_BY_CHARGE_QUERY = `
  query AppEventsByCharge($appId: ID!, $chargeId: ID!, $types: [AppEventTypes!]!, $first: Int!) {
    app(id: $appId) {
      id
      events(first: $first, chargeId: $chargeId, types: $types) {
        edges {
          node {
            __typename
            type
            occurredAt
            shop { id myshopifyDomain }
            ... on AppSubscriptionEvent {
              charge {
                id
                name
                billingOn
                amount { amount currencyCode }
                test
              }
            }
          }
        }
      }
    }
  }
`;

const EVENTS_BY_SHOP_QUERY = `
  query AppEventsByShop($appId: ID!, $shopId: ID!, $types: [AppEventTypes!]!, $first: Int!) {
    app(id: $appId) {
      id
      events(first: $first, shopId: $shopId, types: $types) {
        edges {
          node {
            __typename
            type
            occurredAt
            shop { id myshopifyDomain }
            ... on AppSubscriptionEvent {
              charge {
                id
                name
                billingOn
                amount { amount currencyCode }
                test
              }
            }
          }
        }
      }
    }
  }
`;

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns all AppSubscriptionEvents on this app for a given charge,
 * sorted newest-first by occurredAt (descending). On failure returns null —
 * callers must distinguish null (failure) from [] (no events found).
 */
export async function getEventsByChargeId(
  chargeGid: string,
  options?: { first?: number; types?: readonly string[] },
): Promise<PartnerAppEvent[] | null> {
  const first = options?.first ?? 20;
  const types = options?.types ?? SUBSCRIPTION_EVENT_TYPES;
  try {
    const body = await partnerApiFetch<{
      app: { events: { edges: Array<{ node: PartnerAppEvent }> } } | null;
    }>(EVENTS_BY_CHARGE_QUERY, {
      appId: appGid(),
      chargeId: chargeGid,
      types,
      first,
    });
    const edges = body.data?.app?.events?.edges ?? [];
    return edges
      .map((e) => e.node)
      .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
  } catch (err) {
    console.error(`[PartnerAPI] getEventsByChargeId failed:`, err);
    return null;
  }
}

/**
 * Same shape as getEventsByChargeId but filtered by the Partner Shop gid.
 * Use when we don't have the subscription gid yet (e.g. discovering a
 * freshly-installed shop). On failure returns null.
 */
export async function getEventsByShopGid(
  shopGid: string,
  options?: { first?: number; types?: readonly string[] },
): Promise<PartnerAppEvent[] | null> {
  const first = options?.first ?? 20;
  const types = options?.types ?? SUBSCRIPTION_EVENT_TYPES;
  try {
    const body = await partnerApiFetch<{
      app: { events: { edges: Array<{ node: PartnerAppEvent }> } } | null;
    }>(EVENTS_BY_SHOP_QUERY, {
      appId: appGid(),
      shopId: shopGid,
      types,
      first,
    });
    const edges = body.data?.app?.events?.edges ?? [];
    return edges
      .map((e) => e.node)
      .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
  } catch (err) {
    console.error(`[PartnerAPI] getEventsByShopGid failed:`, err);
    return null;
  }
}

/**
 * Resolves the current state of an app subscription via the Partner API by
 * its GraphQL gid (`gid://shopify/AppSubscription/...`).
 *
 * Looks at the most-recent AppSubscriptionEvent and maps the event type to
 * a status enum. Plan name → tier comes from PLAN_NAME_TO_TIER; cycle from
 * PLAN_NAME_TO_CYCLE.
 *
 * Fail-safe: returns `status: "unknown"` (with a populated `reason`) on any
 * of: network/GraphQL error, no events returned, charge missing on the
 * event, unmappable event type, unrecognised plan name. Callers MUST NOT
 * demote tier when status is "unknown".
 */
export async function getActiveSubscriptionByChargeId(
  chargeGid: string,
): Promise<PartnerActiveSubscription> {
  if (!chargeGid || !chargeGid.startsWith("gid://shopify/AppSubscription/")) {
    return UNKNOWN(`invalid chargeGid "${chargeGid}"`);
  }

  const events = await getEventsByChargeId(chargeGid, { first: 20 });
  if (events === null) {
    return UNKNOWN("partner-api-fetch-failed");
  }
  if (events.length === 0) {
    return UNKNOWN("no-matching-events");
  }

  const latest = events[0];
  const status = EVENT_TYPE_TO_STATUS[latest.type] ?? null;
  if (!status) {
    return UNKNOWN(`unmappable-event-type "${latest.type}"`);
  }
  if (!latest.charge) {
    return UNKNOWN("event-missing-charge");
  }

  const planName = latest.charge.name as PlanName;
  const tier = PLAN_NAME_TO_TIER[planName] ?? null;
  const cycle = PLAN_NAME_TO_CYCLE[planName] ?? null;

  if (tier == null) {
    // We can still report status (e.g. "cancelled" with unknown plan), but
    // callers reconciling tier MUST treat the missing tier as "unknown" too.
    return {
      ...UNKNOWN(`unmapped-plan-name "${planName}"`),
      status,
      planName,
      subscriptionGid: latest.charge.id,
      billingOn: latest.charge.billingOn,
      activatedAt: latest.occurredAt,
      test: latest.charge.test,
    };
  }

  return {
    status,
    planName,
    tier,
    cycle,
    subscriptionGid: latest.charge.id,
    billingOn: latest.charge.billingOn,
    activatedAt: latest.occurredAt,
    test: latest.charge.test,
    reason: null,
  };
}

/**
 * Builds the GraphQL gid for a numeric AppSubscription ID.
 * Use when only the numeric id (e.g. from a `?charge_id=` URL param) is in
 * hand — both `getEventsByChargeId` and `getActiveSubscriptionByChargeId`
 * require the full gid.
 */
export function buildAppSubscriptionGid(numericId: string | number): string {
  return `gid://shopify/AppSubscription/${numericId}`;
}
