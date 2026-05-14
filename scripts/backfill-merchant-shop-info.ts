/**
 * scripts/backfill-merchant-shop-info.ts
 *
 * One-off backfill: walks every installed merchant, calls Shopify Admin API
 * via getShopInfo(), and writes the new metadata columns onto merchants.
 *
 * Usage:
 *   npx tsx scripts/backfill-merchant-shop-info.ts          # all installed merchants
 *   npx tsx scripts/backfill-merchant-shop-info.ts --all    # include uninstalled too
 *   npx tsx scripts/backfill-merchant-shop-info.ts --shop mystore.myshopify.com
 *
 * Requires the same env vars the app uses:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TOKEN_ENCRYPTION_KEY,
 *   SHOPIFY_API_KEY, SHOPIFY_API_SECRET.
 */

import "dotenv/config";
import { supabase } from "../app/supabase.server";
import { createAdminClient, getShopInfo } from "../app/lib/shopify-api.server";

interface MerchantRow {
  id: string;
  shopify_domain: string;
  uninstalled_at: string | null;
}

const args = process.argv.slice(2);
const includeUninstalled = args.includes("--all");
const shopFlag = args.indexOf("--shop");
const onlyShop = shopFlag >= 0 ? args[shopFlag + 1] : null;

async function loadMerchants(): Promise<MerchantRow[]> {
  let query = supabase
    .from("merchants")
    .select("id, shopify_domain, uninstalled_at");

  if (onlyShop) {
    query = query.eq("shopify_domain", onlyShop);
  } else if (!includeUninstalled) {
    query = query.is("uninstalled_at", null);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Supabase select failed: ${error.message}`);
  return (data ?? []) as MerchantRow[];
}

async function backfillOne(m: MerchantRow): Promise<"ok" | "no_token" | "no_shop_info" | "update_failed"> {
  let executor;
  try {
    executor = await createAdminClient(m.shopify_domain);
  } catch (err) {
    console.warn(
      `  ⚠️  ${m.shopify_domain}: cannot build admin client (${(err as Error).message})`,
    );
    return "no_token";
  }

  const shopInfo = await getShopInfo(executor);
  if (!shopInfo) {
    console.warn(`  ⚠️  ${m.shopify_domain}: getShopInfo returned null`);
    return "no_shop_info";
  }

  const { error } = await supabase
    .from("merchants")
    .update({
      shop_name: shopInfo.name,
      shop_owner_name: shopInfo.shopOwnerName,
      contact_email: shopInfo.contactEmail,
      country: shopInfo.billingAddress.country,
      province: shopInfo.billingAddress.province,
      city: shopInfo.billingAddress.city,
      currency_code: shopInfo.currencyCode,
      shopify_plan: shopInfo.plan.displayName,
      primary_domain: shopInfo.primaryDomain.host,
      shop_created_at: shopInfo.createdAt,
      iana_timezone: shopInfo.ianaTimezone,
      shop_metadata_refreshed_at: new Date().toISOString(),
    })
    .eq("id", m.id);

  if (error) {
    console.error(`  ❌ ${m.shopify_domain}: update failed: ${error.message}`);
    return "update_failed";
  }

  console.log(
    `  ✅ ${m.shopify_domain} — owner=${shopInfo.shopOwnerName ?? "(none)"}, country=${shopInfo.billingAddress.country ?? "(none)"}, plan=${shopInfo.plan.displayName ?? "(none)"}`,
  );
  return "ok";
}

async function main() {
  const merchants = await loadMerchants();
  console.log(
    `Backfilling ${merchants.length} merchant${merchants.length === 1 ? "" : "s"}${
      includeUninstalled ? " (including uninstalled)" : ""
    }${onlyShop ? ` filtered to ${onlyShop}` : ""}...\n`,
  );

  const tally = { ok: 0, no_token: 0, no_shop_info: 0, update_failed: 0 };

  for (const m of merchants) {
    const status = await backfillOne(m);
    tally[status]++;
    // 250ms pause to stay under Shopify's GraphQL rate limit comfortably
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log("\nDone.");
  console.log(
    `  ok=${tally.ok}  no_token=${tally.no_token}  no_shop_info=${tally.no_shop_info}  update_failed=${tally.update_failed}`,
  );
}

main()
  .catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  })
  .then(() => process.exit(0));
