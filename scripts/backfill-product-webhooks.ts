/**
 * scripts/backfill-product-webhooks.ts
 *
 * One-off backfill: provision the per-shop products/create + products/update
 * webhook subscriptions for every active PAID merchant.
 *
 * Context: products/* webhooks moved from app-level (shopify.app.toml) to
 * per-shop subscriptions that only paid merchants get (see
 * app/lib/webhooks/product-webhooks.server.ts). Existing paid merchants were
 * subscribed via the OLD app-level registration; this script registers the
 * NEW per-shop subscriptions for them so enrichment keeps flowing across the
 * `shopify app deploy` that deregisters the app-level subscription.
 *
 * RUN ORDER (founder, against prod env):
 *   1. git push (deploy the new handler/helper code — no Shopify webhook
 *      change yet, since the toml hasn't been pushed to Shopify).
 *   2. npx tsx scripts/backfill-product-webhooks.ts   ← THIS SCRIPT
 *      Verify every paid shop shows created or existing for both topics.
 *   3. shopify app deploy (deregisters the app-level products/* + themes/*).
 *
 * ensureProductWebhooks is idempotent, so re-running is safe. There is a brief
 * harmless double-delivery window for paid shops between steps 2 and 3 (both
 * the app-level and per-shop subscriptions are live); the handler dedups via
 * schema_enrichments + the pending_scan_triggers queue.
 *
 * Requires the same env vars the app uses:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TOKEN_ENCRYPTION_KEY,
 *   SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_APP_URL.
 */

import "dotenv/config";
import { supabase } from "../app/supabase.server";
import { PAID_TIERS } from "../app/lib/billing/plans";
import { ensureProductWebhooks } from "../app/lib/webhooks/product-webhooks.server";

interface MerchantRow {
  id: string;
  shopify_domain: string;
  tier: string;
}

interface ReportRow {
  shop: string;
  tier: string;
  created: string[];
  existing: string[];
  errors: string[];
}

async function loadPaidMerchants(): Promise<MerchantRow[]> {
  const { data, error } = await supabase
    .from("merchants")
    .select("id, shopify_domain, tier")
    .in("tier", PAID_TIERS as readonly string[])
    .is("uninstalled_at", null);

  if (error) throw new Error(`Supabase select failed: ${error.message}`);
  return (data ?? []) as MerchantRow[];
}

async function main() {
  const merchants = await loadPaidMerchants();
  console.log(
    `Provisioning per-shop products/* webhooks for ${merchants.length} active paid merchant${
      merchants.length === 1 ? "" : "s"
    }...\n`,
  );

  const report: ReportRow[] = [];

  for (const m of merchants) {
    const summary = await ensureProductWebhooks(m.shopify_domain);
    report.push({
      shop: m.shopify_domain,
      tier: m.tier,
      created: summary.created,
      existing: summary.existing,
      errors: summary.errors,
    });

    const status = summary.errors.length
      ? `❌ errors: ${summary.errors.join("; ")}`
      : `✅ created=[${summary.created.join(", ")}] existing=[${summary.existing.join(", ")}]`;
    console.log(`  ${m.shopify_domain} (${m.tier}) — ${status}`);

    // 250ms pacing to stay comfortably under Shopify's GraphQL rate limit.
    await new Promise((r) => setTimeout(r, 250));
  }

  // ── Final table ───────────────────────────────────────────────────────────
  console.log("\n" + "─".repeat(96));
  console.log(
    "SHOP".padEnd(40) +
      "TIER".padEnd(14) +
      "CREATED".padEnd(22) +
      "EXISTING",
  );
  console.log("─".repeat(96));
  for (const r of report) {
    console.log(
      r.shop.padEnd(40) +
        r.tier.padEnd(14) +
        (r.created.join(",") || "-").padEnd(22) +
        (r.existing.join(",") || "-") +
        (r.errors.length ? `   ⚠️ ${r.errors.join("; ")}` : ""),
    );
  }
  console.log("─".repeat(96));

  const withErrors = report.filter((r) => r.errors.length).length;
  const fullyCovered = report.filter(
    (r) => r.created.length + r.existing.length >= 2 && !r.errors.length,
  ).length;
  console.log(
    `\nDone. ${fullyCovered}/${report.length} shops have BOTH topics provisioned; ${withErrors} with errors.`,
  );
  if (withErrors > 0) {
    console.log(
      "⚠️  Re-run after investigating errors before running `shopify app deploy`.",
    );
  }
}

main()
  .catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  })
  .then(() => process.exit(0));
