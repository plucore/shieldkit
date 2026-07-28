/**
 * app/lib/webhooks/product-webhooks.server.ts
 *
 * Per-shop programmatic management of the products/create + products/update
 * webhook subscriptions.
 *
 * Why this exists: ongoing GTIN/MPN/brand enrichment is a paid-only feature,
 * but app-level (shopify.app.toml) webhook subscriptions register for EVERY
 * install regardless of tier. A single free store running an inventory-sync
 * app generated ~16k products/* deliveries/day, every one of which invoked the
 * serverless function + HMAC + a DB read only to bail at the tier gate. Moving
 * products/* to per-shop subscriptions created ONLY for paid merchants drives
 * that wasted free-tier traffic to zero.
 *
 * Both functions are idempotent and safe to call repeatedly:
 *   - ensureProductWebhooks — create the two subscriptions if missing (called
 *     on the upgrade path + the daily self-heal + paid reinstall).
 *   - removeProductWebhooks — delete them (called when a merchant is demoted
 *     to free). Uninstall needs no cleanup — Shopify auto-removes all webhooks
 *     when the access token is revoked.
 *
 * This module subscribes to NOTHING other than products/create +
 * products/update. The remaining lifecycle / GDPR / billing webhooks stay
 * app-level in shopify.app.toml.
 *
 * All work is best-effort: errors are reported to Sentry and returned in the
 * summary, never thrown, so a webhook hiccup can never block a billing
 * redirect or a cron pass.
 */

import { createAdminClient } from "../shopify-api.server";
import { sentry } from "../sentry.server";

// The two topics this module owns. Shopify's WebhookSubscriptionTopic enum
// values (NOT the dotted topic strings used in shopify.app.toml).
const PRODUCT_TOPICS = ["PRODUCTS_CREATE", "PRODUCTS_UPDATE"] as const;

/**
 * The ONLY payload field this app's handler reads.
 *
 * webhooks.products.update.tsx:215-219 reads `payload.id` and nothing else —
 * every other field in a full product payload (title, variants, images, body_html,
 * updated_at, …) is dead weight. A full product payload is routinely tens of KB;
 * this one is a few dozen bytes.
 *
 * Two reasons to narrow it, with very different levels of confidence:
 *
 *  1. CERTAIN — payload size. `includeFields` is documented as "Only the fields
 *     specified will be included in the webhook payload"
 *     (shopify.dev/docs/api/admin-graphql/2026-04/input-objects/WebhookSubscriptionInput).
 *     That directly cuts Vercel Fast Origin Transfer, which was ~18.6 GB in the
 *     May-June blow-out.
 *
 *  2. UNVERIFIED — delivery count. Omitting `updated_at` is widely reported to
 *     let Shopify suppress a redelivery whose payload is byte-identical to the
 *     previous one, which would cut the ~2.37 deliveries-per-product redundancy
 *     measured in July. I could NOT find this in Shopify's documentation — the
 *     schema docs describe payload contents only. Treat it as a hypothesis that
 *     the 48h delivery count will confirm or refute; do not bank the saving.
 *
 * If the handler ever needs another field, add it here AND redeploy — an existing
 * subscription does not pick this up on its own (see the update path below).
 */
const DESIRED_INCLUDE_FIELDS = ["id"] as const;
type ProductTopic = (typeof PRODUCT_TOPICS)[number];

interface WebhookEndpointNode {
  id: string;
  topic: string;
  includeFields?: string[] | null;
  endpoint: {
    __typename: string;
    callbackUrl?: string | null;
  };
}

interface ListResponse {
  webhookSubscriptions: {
    edges: { node: WebhookEndpointNode }[];
  };
}

interface CreateResponse {
  webhookSubscriptionCreate: {
    webhookSubscription: { id: string } | null;
    userErrors: { field: string[] | null; message: string }[];
  };
}

interface UpdateResponse {
  webhookSubscriptionUpdate: {
    webhookSubscription: { id: string; includeFields: string[] } | null;
    userErrors: { field: string[] | null; message: string }[];
  };
}

interface DeleteResponse {
  webhookSubscriptionDelete: {
    deletedWebhookSubscriptionId: string | null;
    userErrors: { field: string[] | null; message: string }[];
  };
}

const LIST_QUERY = /* GraphQL */ `
  query ProductWebhookSubscriptions {
    webhookSubscriptions(
      first: 50
      topics: [PRODUCTS_CREATE, PRODUCTS_UPDATE]
    ) {
      edges {
        node {
          id
          topic
          includeFields
          endpoint {
            __typename
            ... on WebhookHttpEndpoint {
              callbackUrl
            }
          }
        }
      }
    }
  }
`;

const CREATE_MUTATION = /* GraphQL */ `
  mutation ProductWebhookCreate(
    $topic: WebhookSubscriptionTopic!
    $sub: WebhookSubscriptionInput!
  ) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
      webhookSubscription {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const UPDATE_MUTATION = /* GraphQL */ `
  mutation ProductWebhookUpdate($id: ID!, $sub: WebhookSubscriptionInput!) {
    webhookSubscriptionUpdate(id: $id, webhookSubscription: $sub) {
      webhookSubscription {
        id
        includeFields
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const DELETE_MUTATION = /* GraphQL */ `
  mutation ProductWebhookDelete($id: ID!) {
    webhookSubscriptionDelete(id: $id) {
      deletedWebhookSubscriptionId
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * The callback URL the per-shop subscriptions point at — the same handler the
 * app-level subscription used to target. Trailing slash on SHOPIFY_APP_URL is
 * tolerated so the URL is stable across env formats.
 */
function targetCallbackUrl(): string {
  const base = (process.env.SHOPIFY_APP_URL || "").replace(/\/+$/, "");
  return `${base}/webhooks/products/update`;
}

/**
 * A userError that means "this exact (topic, address) subscription is already
 * present" is a success for our idempotent contract, not a failure. Shopify's
 * wording has varied ("already been taken", "already exists for this topic and
 * address"), so match loosely.
 */
function isAlreadyExistsError(message: string): boolean {
  return /already|has been taken|exists/i.test(message);
}

export interface EnsureProductWebhooksResult {
  created: string[];
  existing: string[];
  /** Existing subscriptions whose includeFields were narrowed in place. */
  updated: string[];
  errors: string[];
}

/**
 * Ensure products/create + products/update subscriptions exist for this shop,
 * pointing at our handler. Idempotent. Existing subscriptions are left alone
 * EXCEPT that their includeFields are brought in line with
 * DESIRED_INCLUDE_FIELDS — without that, a change to the desired field list
 * would only ever apply to future subscribers.
 * Never throws; failures are captured to Sentry and returned in `errors`.
 */
export async function ensureProductWebhooks(
  shopDomain: string,
): Promise<EnsureProductWebhooksResult> {
  const result: EnsureProductWebhooksResult = {
    created: [],
    existing: [],
    updated: [],
    errors: [],
  };
  const target = targetCallbackUrl();

  let executor;
  try {
    executor = await createAdminClient(shopDomain);
  } catch (err) {
    sentry.captureException(err, {
      tags: { area: "product-webhooks", op: "ensure", branch: "admin_client" },
      extra: { shop: shopDomain },
    });
    result.errors.push(
      `admin_client: ${err instanceof Error ? err.message : String(err)}`,
    );
    return result;
  }

  // Which topics already point at our target callback URL?
  const alreadyTargeted = new Set<string>();
  const existingByTopic = new Map<
    string,
    { id: string; includeFields: string[] | null }
  >();
  try {
    const res = await executor<ListResponse>(LIST_QUERY);
    if (res.errors?.length) {
      throw new Error(res.errors.map((e) => e.message).join("; "));
    }
    for (const edge of res.data?.webhookSubscriptions.edges ?? []) {
      const node = edge.node;
      if (node.endpoint?.callbackUrl === target) {
        alreadyTargeted.add(node.topic);
        existingByTopic.set(node.topic, {
          id: node.id,
          includeFields: node.includeFields ?? null,
        });
      }
    }
  } catch (err) {
    // A failed list is non-fatal: fall through and attempt creates. Shopify's
    // "already exists" userError is the backstop against a duplicate.
    sentry.captureException(err, {
      tags: { area: "product-webhooks", op: "ensure", branch: "list" },
      extra: { shop: shopDomain },
    });
    result.errors.push(
      `list: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  for (const topic of PRODUCT_TOPICS) {
    if (alreadyTargeted.has(topic)) {
      result.existing.push(topic);
      // An EXISTING subscription does not inherit a change to
      // DESIRED_INCLUDE_FIELDS — this branch used to `continue` immediately,
      // which would have silently excluded every already-subscribed merchant
      // from the narrowing. That is the same class of mistake as committing a
      // toml change without running `shopify app deploy`: the code changes and
      // production does not. webhookSubscriptionUpdate exists precisely to
      // "modify ... included fields without recreating the subscription".
      const existing = existingByTopic.get(topic);
      const desired = [...DESIRED_INCLUDE_FIELDS];
      const current = existing?.includeFields ?? null;
      const upToDate =
        current !== null &&
        current.length === desired.length &&
        desired.every((f) => current.includes(f));
      if (existing && !upToDate) {
        try {
          const upd = await executor<UpdateResponse>(UPDATE_MUTATION, {
            id: existing.id,
            sub: { includeFields: desired },
          });
          const errs = upd.data?.webhookSubscriptionUpdate.userErrors ?? [];
          if (upd.errors?.length || errs.length > 0) {
            const msg = [
              ...(upd.errors ?? []).map((e) => e.message),
              ...errs.map((e) => e.message),
            ].join("; ");
            result.errors.push(`update ${topic}: ${msg}`);
            sentry.captureException(new Error(msg), {
              tags: { area: "product-webhooks", op: "ensure", branch: "update_include_fields" },
              extra: { shop: shopDomain, topic },
            });
          } else {
            result.updated.push(topic);
          }
        } catch (err) {
          result.errors.push(
            `update ${topic}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      continue;
    }

    try {
      const res = await executor<CreateResponse>(CREATE_MUTATION, {
        topic: topic as ProductTopic,
        sub: {
          callbackUrl: target,
          format: "JSON",
          includeFields: [...DESIRED_INCLUDE_FIELDS],
        },
      });

      if (res.errors?.length) {
        throw new Error(res.errors.map((e) => e.message).join("; "));
      }

      const userErrors = res.data?.webhookSubscriptionCreate.userErrors ?? [];
      if (userErrors.length > 0) {
        if (userErrors.every((e) => isAlreadyExistsError(e.message))) {
          // Already present for this (topic, address) — idempotent success.
          result.existing.push(topic);
        } else {
          const msg = userErrors.map((e) => e.message).join("; ");
          sentry.captureException(new Error(msg), {
            tags: {
              area: "product-webhooks",
              op: "ensure",
              branch: "create_user_error",
            },
            extra: { shop: shopDomain, topic },
          });
          result.errors.push(`${topic}: ${msg}`);
        }
        continue;
      }

      result.created.push(topic);
    } catch (err) {
      sentry.captureException(err, {
        tags: { area: "product-webhooks", op: "ensure", branch: "create" },
        extra: { shop: shopDomain, topic },
      });
      result.errors.push(
        `${topic}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return result;
}

export interface RemoveProductWebhooksResult {
  deleted: string[];
  errors: string[];
}

/**
 * Delete any products/create + products/update subscriptions that point at our
 * handler for this shop. Idempotent — a shop with none is a no-op. Never
 * throws; failures are captured to Sentry and returned in `errors`.
 */
export async function removeProductWebhooks(
  shopDomain: string,
): Promise<RemoveProductWebhooksResult> {
  const result: RemoveProductWebhooksResult = { deleted: [], errors: [] };
  const target = targetCallbackUrl();

  let executor;
  try {
    executor = await createAdminClient(shopDomain);
  } catch (err) {
    sentry.captureException(err, {
      tags: { area: "product-webhooks", op: "remove", branch: "admin_client" },
      extra: { shop: shopDomain },
    });
    result.errors.push(
      `admin_client: ${err instanceof Error ? err.message : String(err)}`,
    );
    return result;
  }

  let nodes: WebhookEndpointNode[] = [];
  try {
    const res = await executor<ListResponse>(LIST_QUERY);
    if (res.errors?.length) {
      throw new Error(res.errors.map((e) => e.message).join("; "));
    }
    nodes = (res.data?.webhookSubscriptions.edges ?? []).map((e) => e.node);
  } catch (err) {
    sentry.captureException(err, {
      tags: { area: "product-webhooks", op: "remove", branch: "list" },
      extra: { shop: shopDomain },
    });
    result.errors.push(
      `list: ${err instanceof Error ? err.message : String(err)}`,
    );
    return result;
  }

  const toDelete = nodes.filter((n) => n.endpoint?.callbackUrl === target);

  for (const node of toDelete) {
    try {
      const res = await executor<DeleteResponse>(DELETE_MUTATION, {
        id: node.id,
      });

      if (res.errors?.length) {
        throw new Error(res.errors.map((e) => e.message).join("; "));
      }

      const userErrors = res.data?.webhookSubscriptionDelete.userErrors ?? [];
      if (userErrors.length > 0) {
        const msg = userErrors.map((e) => e.message).join("; ");
        sentry.captureException(new Error(msg), {
          tags: {
            area: "product-webhooks",
            op: "remove",
            branch: "delete_user_error",
          },
          extra: { shop: shopDomain, topic: node.topic },
        });
        result.errors.push(`${node.topic}: ${msg}`);
        continue;
      }

      result.deleted.push(node.topic);
    } catch (err) {
      sentry.captureException(err, {
        tags: { area: "product-webhooks", op: "remove", branch: "delete" },
        extra: { shop: shopDomain, topic: node.topic },
      });
      result.errors.push(
        `${node.topic}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return result;
}
