/**
 * scripts/prune-enrichment-log.ts
 *
 * OPTIONAL hygiene (manual only — never wired to a cron). enrichment_webhook_log
 * holds ~224K rows, ~84% of which are pre-May-2026 skip_tier audit junk from the
 * old app-level products/* subscription. At ~62MB the DB is nowhere near a limit,
 * so this is low priority — kept as a manual tool, not auto-run.
 *
 * Deletes enrichment_webhook_log rows older than RETENTION_DAYS (default 30).
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/prune-enrichment-log.ts                 # report only (dry-run)
 *   npx tsx --env-file=.env scripts/prune-enrichment-log.ts --apply         # delete
 *   npx tsx --env-file=.env scripts/prune-enrichment-log.ts --days=60 --apply
 *
 * Required env vars:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */

import "dotenv/config";
import { supabase } from "../app/supabase.server";

const APPLY = process.argv.includes("--apply");
const daysArg = process.argv.find((a) => a.startsWith("--days="));
const RETENTION_DAYS = daysArg ? Math.max(1, parseInt(daysArg.split("=")[1], 10) || 30) : 30;

// Delete in batches so a huge backlog can't blow the statement timeout.
const DELETE_BATCH = 5000;

async function main() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  console.log(
    `Prune enrichment_webhook_log older than ${RETENTION_DAYS}d (created_at < ${cutoff}) — ` +
      `mode: ${APPLY ? "APPLY" : "dry-run"}`,
  );

  const { count: totalOld, error: cErr } = await supabase
    .from("enrichment_webhook_log")
    .select("id", { count: "exact", head: true })
    .lt("created_at", cutoff);
  if (cErr) throw new Error(`count failed: ${cErr.message}`);

  console.log(`Rows older than cutoff: ${totalOld ?? 0}`);

  if (!APPLY) {
    console.log(`\nDry-run: would delete ${totalOld ?? 0} rows. Re-run with --apply.`);
    return;
  }

  if (!totalOld) {
    console.log("\nNothing to delete.");
    return;
  }

  let deletedTotal = 0;
  // Batched delete: grab a page of old ids, delete them, repeat until none left.
  for (;;) {
    const { data: page, error: pErr } = await supabase
      .from("enrichment_webhook_log")
      .select("id")
      .lt("created_at", cutoff)
      .order("id", { ascending: true })
      .limit(DELETE_BATCH);
    if (pErr) throw new Error(`select page failed: ${pErr.message}`);
    if (!page || page.length === 0) break;

    const ids = (page as { id: number }[]).map((r) => r.id);
    const { error: dErr } = await supabase
      .from("enrichment_webhook_log")
      .delete()
      .in("id", ids);
    if (dErr) throw new Error(`delete batch failed: ${dErr.message}`);

    deletedTotal += ids.length;
    console.log(`  deleted ${deletedTotal}/${totalOld}...`);
    if (page.length < DELETE_BATCH) break;
  }

  console.log(`\n🧹 Deleted ${deletedTotal} enrichment_webhook_log rows older than ${RETENTION_DAYS}d.`);
}

main()
  .catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  })
  .then(() => process.exit(0));
