#!/usr/bin/env tsx
/**
 * scripts/cleanup-orphan-webhooks.ts
 *
 * One-off script to remove orphaned shop-specific webhook subscriptions left
 * over from `shopify app dev` sessions. These point at dead trycloudflare.com
 * tunnel URLs and produce failed deliveries in the Shopify admin.
 *
 * Usage:
 *   npx tsx scripts/cleanup-orphan-webhooks.ts
 *
 * Required env vars:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TOKEN_ENCRYPTION_KEY
 */

import { createClient } from "@supabase/supabase-js";
import {
  createDecipheriv,
  scryptSync,
} from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const SHOP_DOMAIN = "shieldkit-test-stor.myshopify.com";
const SHOPIFY_API_VERSION = "2025-10";
const ALLOWED_HOST = "shieldkit.vercel.app";

// ─────────────────────────────────────────────────────────────────────────────
// Inline crypto (avoids importing from app/ which pulls in Supabase singleton)
// ─────────────────────────────────────────────────────────────────────────────

const ALGO = "aes-256-gcm";
const SALT = "shieldkit-token-v1";
let _derivedKey: Buffer | null = null;

function getKey(): Buffer {
  if (_derivedKey) return _derivedKey;
  const secret = process.env.TOKEN_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY must be set and at least 32 characters long"
    );
  }
  _derivedKey = scryptSync(secret, SALT, 32);
  return _derivedKey;
}

function decrypt(ciphertext: string): string {
  const parts = ciphertext.split(":");
  if (parts.length !== 3) {
    throw new Error(
      `Invalid ciphertext format: expected 3 colon-separated parts, got ${parts.length}`
    );
  }
  const [ivHex, authTagHex, encHex] = parts;
  const decipher = createDecipheriv(ALGO, getKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encHex, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

// ─────────────────────────────────────────────────────────────────────────────
// Supabase client
// ─────────────────────────────────────────────────────────────────────────────

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Access token lookup (mirrors createAdminClient logic)
// ─────────────────────────────────────────────────────────────────────────────

async function getAccessToken(shopDomain: string): Promise<string> {
  const supabase = getSupabase();

  // Primary: sessions table (freshest after token rotation)
  const { data: session } = await supabase
    .from("sessions")
    .select("access_token")
    .eq("shop", shopDomain)
    .eq("is_online", false)
    .order("expires", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  if (session?.access_token) {
    try {
      return decrypt(session.access_token);
    } catch (e) {
      console.warn(`⚠ Failed to decrypt session token, trying merchants table...`);
    }
  }

  // Fallback: merchants table
  const { data: merchant } = await supabase
    .from("merchants")
    .select("access_token_encrypted")
    .eq("shopify_domain", shopDomain)
    .maybeSingle();

  if (merchant?.access_token_encrypted) {
    return decrypt(merchant.access_token_encrypted);
  }

  throw new Error(`No access token found for ${shopDomain}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shopify GraphQL helpers
// ─────────────────────────────────────────────────────────────────────────────

interface WebhookNode {
  id: string;
  topic: string;
  callbackUrl: string;
  endpoint: {
    __typename: string;
  };
}

interface WebhookListResponse {
  data: {
    webhookSubscriptions: {
      edges: { node: WebhookNode }[];
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
    };
  } | null;
  errors?: { message: string }[];
}

interface WebhookDeleteResponse {
  data: {
    webhookSubscriptionDelete: {
      deletedWebhookSubscriptionId: string | null;
      userErrors: { field: string[]; message: string }[];
    };
  } | null;
  errors?: { message: string }[];
}

const WEBHOOK_LIST_QUERY = `
  query webhookSubscriptions($first: Int!, $after: String) {
    webhookSubscriptions(first: $first, after: $after) {
      edges {
        node {
          id
          topic
          callbackUrl
          endpoint {
            __typename
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const WEBHOOK_DELETE_MUTATION = `
  mutation webhookSubscriptionDelete($id: ID!) {
    webhookSubscriptionDelete(id: $id) {
      deletedWebhookSubscriptionId
      userErrors {
        field
        message
      }
    }
  }
`;

async function graphql<T>(
  shopDomain: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  const endpoint = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} from ${shopDomain}: ${text.slice(0, 500)}`);
  }

  return res.json() as Promise<T>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

function isOrphan(callbackUrl: string): boolean {
  try {
    const host = new URL(callbackUrl).host;
    return host !== ALLOWED_HOST;
  } catch {
    // Relative URLs or malformed — these are fine (app-level subscriptions)
    return false;
  }
}

async function main() {
  console.log(`\n🔍 Looking up access token for ${SHOP_DOMAIN}...\n`);
  const accessToken = await getAccessToken(SHOP_DOMAIN);
  console.log(`✅ Access token retrieved.\n`);

  // ── Phase 1: List all webhook subscriptions (paginated) ──────────────────
  console.log(`📋 Fetching all webhook subscriptions...\n`);

  const allWebhooks: WebhookNode[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;

  while (hasNextPage) {
    const result = await graphql<WebhookListResponse>(
      SHOP_DOMAIN,
      accessToken,
      WEBHOOK_LIST_QUERY,
      { first: 100, after: cursor }
    );

    if (result.errors?.length) {
      console.error("❌ GraphQL errors:", result.errors);
      process.exit(1);
    }

    const connection = result.data!.webhookSubscriptions;
    for (const edge of connection.edges) {
      allWebhooks.push(edge.node);
    }

    hasNextPage = connection.pageInfo.hasNextPage;
    cursor = connection.pageInfo.endCursor;
  }

  console.log(`Found ${allWebhooks.length} total webhook subscription(s):\n`);
  console.log("─".repeat(90));
  console.log(
    "ID".padEnd(50) + "Topic".padEnd(25) + "Callback URL"
  );
  console.log("─".repeat(90));

  for (const wh of allWebhooks) {
    console.log(
      `${wh.id.padEnd(50)}${wh.topic.padEnd(25)}${wh.callbackUrl}`
    );
  }
  console.log("─".repeat(90));

  // ── Phase 2: Identify orphans ────────────────────────────────────────────
  const orphans = allWebhooks.filter((wh) => isOrphan(wh.callbackUrl));

  if (orphans.length === 0) {
    console.log("\n✅ No orphaned webhook subscriptions found. Nothing to delete.\n");
    process.exit(0);
  }

  console.log(
    `\n⚠️  Found ${orphans.length} orphaned subscription(s) to delete:\n`
  );
  for (const wh of orphans) {
    console.log(`  🗑  ${wh.topic.padEnd(30)} → ${wh.callbackUrl}`);
  }

  // ── Phase 3: Delete orphans ──────────────────────────────────────────────
  console.log(`\n🧹 Deleting ${orphans.length} orphaned subscription(s)...\n`);

  let deleted = 0;
  let failed = 0;

  for (const wh of orphans) {
    const result = await graphql<WebhookDeleteResponse>(
      SHOP_DOMAIN,
      accessToken,
      WEBHOOK_DELETE_MUTATION,
      { id: wh.id }
    );

    if (result.errors?.length) {
      console.error(`  ❌ ${wh.topic}: GraphQL error — ${result.errors[0].message}`);
      failed++;
      continue;
    }

    const mutation = result.data!.webhookSubscriptionDelete;
    if (mutation.userErrors.length > 0) {
      console.error(
        `  ❌ ${wh.topic}: ${mutation.userErrors.map((e) => e.message).join(", ")}`
      );
      failed++;
    } else {
      console.log(
        `  ✅ Deleted ${wh.topic.padEnd(30)} (${mutation.deletedWebhookSubscriptionId})`
      );
      deleted++;
    }
  }

  console.log(
    `\n🏁 Done. Deleted: ${deleted}, Failed: ${failed}, Kept: ${allWebhooks.length - orphans.length}\n`
  );
}

main().catch((err) => {
  console.error("\n💥 Fatal error:", err);
  process.exit(1);
});
