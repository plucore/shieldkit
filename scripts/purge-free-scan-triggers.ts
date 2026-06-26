/**
 * scripts/purge-free-scan-triggers.ts
 *
 * One-off: delete unprocessed pending_scan_triggers rows that belong to a
 * NON-paid merchant. These are holdovers enqueued while a merchant was paid
 * (e.g. a grandfathered Shield Max shop) that then churned to free — ~860 such
 * rows from May 2026 sat at the head of the queue and, under the old
 * single-row unscoped drainer, starved the legitimate paid backlog.
 *
 * The drainer itself now scopes its SELECT to paid + installed merchants
 * (api.cron.process-scan-triggers.ts), so these rows are already inert — this
 * script just removes the dead weight. Paid (monitoring/recovery/pro)
 * unprocessed rows are LEFT in place for the drainer to process.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/purge-free-scan-triggers.ts            # report only (dry-run)
 *   npx tsx --env-file=.env scripts/purge-free-scan-triggers.ts --apply    # delete
 *
 * Required env vars:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */

import "dotenv/config";
import { supabase } from "../app/supabase.server";
import { hasPaidAccess } from "../app/lib/billing/plans";

const APPLY = process.argv.includes("--apply");

interface MerchantRow {
  id: string;
  shopify_domain: string;
  tier: string;
}

async function main() {
  const { data: merchants, error: mErr } = await supabase
    .from("merchants")
    .select("id, shopify_domain, tier");
  if (mErr) throw new Error(`merchants select failed: ${mErr.message}`);

  const rows = (merchants ?? []) as MerchantRow[];
  const freeIds = rows.filter((m) => !hasPaidAccess(m.tier)).map((m) => m.id);
  const paidIds = rows.filter((m) => hasPaidAccess(m.tier)).map((m) => m.id);

  console.log(
    `Merchants: ${rows.length} total — ${paidIds.length} paid, ${freeIds.length} non-paid.`,
  );

  // How many unprocessed rows belong to non-paid merchants (the purge target)?
  const { count: freeUnprocessed, error: cErr } = await supabase
    .from("pending_scan_triggers")
    .select("id", { count: "exact", head: true })
    .is("processed_at", null)
    .in("merchant_id", freeIds);
  if (cErr) throw new Error(`count(free unprocessed) failed: ${cErr.message}`);

  // How many unprocessed rows belong to PAID merchants (left in place)?
  const { count: paidUnprocessed } = await supabase
    .from("pending_scan_triggers")
    .select("id", { count: "exact", head: true })
    .is("processed_at", null)
    .in("merchant_id", paidIds);

  console.log(
    `Unprocessed triggers — non-paid (purge target): ${freeUnprocessed ?? 0}` +
      `  |  paid (kept for drainer): ${paidUnprocessed ?? 0}`,
  );

  if (!APPLY) {
    console.log(
      `\nDry-run: would delete ${freeUnprocessed ?? 0} non-paid unprocessed rows. ` +
        "Re-run with --apply to delete.",
    );
    return;
  }

  if (!freeUnprocessed) {
    console.log("\nNothing to delete.");
    return;
  }

  const { data: deleted, error: dErr } = await supabase
    .from("pending_scan_triggers")
    .delete()
    .is("processed_at", null)
    .in("merchant_id", freeIds)
    .select("id");
  if (dErr) throw new Error(`delete failed: ${dErr.message}`);

  console.log(`\n🧹 Deleted ${deleted?.length ?? 0} non-paid unprocessed trigger rows.`);
  console.log(`Paid unprocessed rows left for the drainer: ${paidUnprocessed ?? 0}.`);
}

main()
  .catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  })
  .then(() => process.exit(0));
