/**
 * scripts/validate-partner-api.ts
 *
 * Read-only Task 5 validation: confirm getActiveSubscriptionByChargeId
 * agrees with the Supabase merchants row for both live paying merchants.
 *
 * Run with: npx tsx scripts/validate-partner-api.ts
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { getActiveSubscriptionByChargeId } from "../app/lib/billing/partner-api.server";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const TARGETS = ["sbnjen-ee.myshopify.com", "0yzffh-vw.myshopify.com"];

(async () => {
  for (const domain of TARGETS) {
    const { data: row } = await supabase
      .from("merchants")
      .select(
        "shopify_domain, tier, billing_cycle, shopify_subscription_id, subscription_started_at, scans_remaining",
      )
      .eq("shopify_domain", domain)
      .maybeSingle();

    if (!row || !row.shopify_subscription_id) {
      console.log(`\n=== ${domain} ===\nNo merchant or no subscription gid stored. Skipping.`);
      continue;
    }

    const sub = await getActiveSubscriptionByChargeId(row.shopify_subscription_id);
    console.log(`\n=== ${domain} ===`);
    console.log("Supabase :", row);
    console.log("PartnerAPI:", sub);
  }
})().catch((err) => {
  console.error("Validation failed:", err);
  process.exit(1);
});
