/**
 * scripts/remove-products-update-topic.ts
 *
 * Topic-scoped teardown of the PRODUCTS_UPDATE subscription (Block 4 switch).
 *
 * ensureProductWebhooks now CONVERGES onto DESIRED_TOPICS, so every shop the
 * daily reconcile-subscriptions cron touches has PRODUCTS_UPDATE removed for it
 * automatically. This script exists for the shops that cron cannot reach: it
 * filters on `shopify_subscription_id IS NOT NULL`, which permanently excludes
 * the founder's dev store (test-only charges, so no charge id exists to store).
 *
 * Idempotent — a shop with no PRODUCTS_UPDATE subscription is a no-op.
 *
 * Run with `npx tsx`, not `node --experimental-strip-types`: this imports the
 * app's extensionless modules, which Node's ESM resolver cannot resolve.
 *
 *   npx tsx scripts/remove-products-update-topic.ts <shop-domain> [...]
 *
 * Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TOKEN_ENCRYPTION_KEY,
 * SHOPIFY_APP_URL.
 */
import "dotenv/config";
import { removeProductWebhooks } from "../app/lib/webhooks/product-webhooks.server";

const shops = process.argv.slice(2);
if (shops.length === 0) {
  console.error("usage: npx tsx scripts/remove-products-update-topic.ts <shop-domain> [...]");
  process.exit(2);
}

for (const shop of shops) {
  const r = await removeProductWebhooks(shop, ["PRODUCTS_UPDATE"]);
  const status = r.errors.length === 0 ? "OK" : "ERRORS";
  console.log(
    `${status}  ${shop}  deleted=[${r.deleted.join(", ") || "-"}]${
      r.errors.length ? `  errors=[${r.errors.join("; ")}]` : ""
    }`,
  );
}
