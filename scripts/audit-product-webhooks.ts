/**
 * scripts/audit-product-webhooks.ts
 *
 * Audit (and optionally clean up) the per-shop products/create + products/update
 * webhook subscriptions across every installed merchant.
 *
 * Why: products/* webhooks moved from app-level (shopify.app.toml) to per-shop
 * subscriptions that ONLY paid merchants should hold (see
 * app/lib/webhooks/product-webhooks.server.ts). This script:
 *   1. Confirms propagation of that change — every PAID shop should show a
 *      subscription; every FREE shop should show none.
 *   2. Removes stragglers — any NON-paid shop (hasPaidAccess(tier) === false)
 *      that still has a products/* subscription is still cold-starting the
 *      /webhooks/products/update function on every product edit for an
 *      enrichment feature it cannot use. Those subs are deleted.
 *
 * The Admin `webhookSubscriptions` query only returns subscriptions owned by
 * THIS app, so every row it returns is a ShieldKit subscription — deleting a
 * straggler never touches another app's webhooks.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/audit-product-webhooks.ts            # report only (dry-run)
 *   npx tsx --env-file=.env scripts/audit-product-webhooks.ts --apply    # delete free-shop stragglers
 *
 * Required env vars (same as the app):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TOKEN_ENCRYPTION_KEY,
 *   SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_APP_URL.
 */

import "dotenv/config";
import { supabase } from "../app/supabase.server";
import { createAdminClient } from "../app/lib/shopify-api.server";
import { hasPaidAccess } from "../app/lib/billing/plans";

const APPLY = process.argv.includes("--apply");

const LIST_QUERY = /* GraphQL */ `
  query ProductWebhookSubscriptions {
    webhookSubscriptions(first: 50, topics: [PRODUCTS_CREATE, PRODUCTS_UPDATE]) {
      edges {
        node {
          id
          topic
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

interface SubNode {
  id: string;
  topic: string;
  endpoint: { __typename: string; callbackUrl?: string | null };
}

interface ListResponse {
  webhookSubscriptions: { edges: { node: SubNode }[] };
}

interface DeleteResponse {
  webhookSubscriptionDelete: {
    deletedWebhookSubscriptionId: string | null;
    userErrors: { field: string[] | null; message: string }[];
  };
}

interface MerchantRow {
  id: string;
  shopify_domain: string;
  tier: string;
}

interface ReportRow {
  shop: string;
  tier: string;
  paid: boolean;
  subscribedTopics: string[];
  deleted: string[];
  errors: string[];
}

async function loadInstalledMerchants(): Promise<MerchantRow[]> {
  const { data, error } = await supabase
    .from("merchants")
    .select("id, shopify_domain, tier")
    .is("uninstalled_at", null)
    .order("shopify_domain", { ascending: true });

  if (error) throw new Error(`Supabase select failed: ${error.message}`);
  return (data ?? []) as MerchantRow[];
}

async function listProductSubs(shop: string): Promise<SubNode[]> {
  const executor = await createAdminClient(shop);
  const res = await executor<ListResponse>(LIST_QUERY);
  if (res.errors?.length) {
    throw new Error(res.errors.map((e) => e.message).join("; "));
  }
  return (res.data?.webhookSubscriptions.edges ?? []).map((e) => e.node);
}

async function deleteSub(shop: string, sub: SubNode): Promise<void> {
  const executor = await createAdminClient(shop);
  const res = await executor<DeleteResponse>(DELETE_MUTATION, { id: sub.id });
  if (res.errors?.length) {
    throw new Error(res.errors.map((e) => e.message).join("; "));
  }
  const userErrors = res.data?.webhookSubscriptionDelete.userErrors ?? [];
  if (userErrors.length) {
    throw new Error(userErrors.map((e) => e.message).join("; "));
  }
}

async function main() {
  const merchants = await loadInstalledMerchants();
  console.log(
    `Auditing products/* webhook subscriptions for ${merchants.length} installed merchant${
      merchants.length === 1 ? "" : "s"
    } — mode: ${APPLY ? "APPLY (will delete free-shop stragglers)" : "dry-run (report only)"}\n`,
  );

  const report: ReportRow[] = [];

  for (const m of merchants) {
    const paid = hasPaidAccess(m.tier);
    const row: ReportRow = {
      shop: m.shopify_domain,
      tier: m.tier,
      paid,
      subscribedTopics: [],
      deleted: [],
      errors: [],
    };

    try {
      const subs = await listProductSubs(m.shopify_domain);
      row.subscribedTopics = subs.map((s) => s.topic);

      // Straggler cleanup: a non-paid shop must not hold products/* subs.
      if (!paid && subs.length > 0) {
        for (const sub of subs) {
          if (!APPLY) {
            row.deleted.push(`${sub.topic} (would delete)`);
            continue;
          }
          try {
            await deleteSub(m.shopify_domain, sub);
            row.deleted.push(sub.topic);
          } catch (err) {
            row.errors.push(
              `delete ${sub.topic}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    } catch (err) {
      row.errors.push(
        `list: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    report.push(row);
    const flag = row.errors.length
      ? `❌ ${row.errors.join("; ")}`
      : row.subscribedTopics.length
        ? `subscribed=[${row.subscribedTopics.join(",")}]${
            row.deleted.length ? `  →  ${APPLY ? "deleted" : "WOULD DELETE"}=[${row.deleted.join(",")}]` : ""
          }`
        : "subscribed=none";
    console.log(`  ${m.shopify_domain} (${m.tier}) — ${flag}`);

    await new Promise((r) => setTimeout(r, 250)); // pace under Shopify rate limit
  }

  // ── Table ───────────────────────────────────────────────────────────────
  console.log("\n" + "─".repeat(96));
  console.log(
    "SHOP".padEnd(40) + "TIER".padEnd(12) + "PAID".padEnd(7) + "SUBSCRIBED?",
  );
  console.log("─".repeat(96));
  for (const r of report) {
    const subscribed = r.subscribedTopics.length > 0;
    console.log(
      r.shop.padEnd(40) +
        r.tier.padEnd(12) +
        (r.paid ? "t" : "f").padEnd(7) +
        (subscribed ? "t" : "f") +
        (r.deleted.length ? `   ${APPLY ? "🧹 deleted" : "⚠️ would delete"}: ${r.deleted.join(",")}` : "") +
        (r.errors.length ? `   ❌ ${r.errors.join("; ")}` : ""),
    );
  }
  console.log("─".repeat(96));

  const paidWithSub = report.filter((r) => r.paid && r.subscribedTopics.length).length;
  const paidTotal = report.filter((r) => r.paid).length;
  const freeWithSub = report.filter((r) => !r.paid && r.subscribedTopics.length).length;
  const cleaned = report.reduce((n, r) => n + (APPLY ? r.deleted.length : 0), 0);
  const withErrors = report.filter((r) => r.errors.length).length;

  console.log(
    `\nPaid shops subscribed: ${paidWithSub}/${paidTotal}` +
      `  |  Free shops with stragglers: ${freeWithSub}` +
      `  |  ${APPLY ? `Deleted: ${cleaned}` : "Dry-run (no deletions)"}` +
      `  |  Errors: ${withErrors}`,
  );
  if (!APPLY && freeWithSub > 0) {
    console.log("Re-run with --apply to delete the free-shop stragglers above.");
  }
}

main()
  .catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  })
  .then(() => process.exit(0));
