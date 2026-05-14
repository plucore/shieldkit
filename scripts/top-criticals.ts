/**
 * scripts/top-criticals.ts
 *
 * One-off: dump critical violations from the latest scan per merchant
 * for the Tier 2 retargeting list. Used to fill in the [PASTE TOP CRITICAL]
 * placeholders in the Gmail drafts.
 */

import "dotenv/config";
import { supabase } from "../app/supabase.server";

const TARGETS = [
  "ymk6v3-f2.myshopify.com",
  "7nqnr9-si.myshopify.com",
  "p4mrnu-hx.myshopify.com",
  "dgv40k-cs.myshopify.com",
  "9yk1ci-0p.myshopify.com",
  "bybaanoo.myshopify.com",
];

async function main() {
  const { data: merchants, error: mErr } = await supabase
    .from("merchants")
    .select("id, shopify_domain")
    .in("shopify_domain", TARGETS);
  if (mErr) throw mErr;

  for (const m of (merchants ?? []) as { id: string; shopify_domain: string }[]) {
    const { data: scan } = await supabase
      .from("scans")
      .select("id, compliance_score, created_at")
      .eq("merchant_id", m.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!scan) {
      console.log(`\n=== ${m.shopify_domain}: no scan ===`);
      continue;
    }
    const { data: viols } = await supabase
      .from("violations")
      .select("check_name, title, description, fix_instruction")
      .eq("scan_id", scan.id)
      .eq("severity", "critical")
      .eq("passed", false);

    console.log(
      `\n=== ${m.shopify_domain} (score ${scan.compliance_score}, ${viols?.length ?? 0} critical) ===`,
    );
    for (const v of (viols ?? []) as Array<{
      check_name: string;
      title: string;
      description: string;
      fix_instruction: string;
    }>) {
      console.log(`  [${v.check_name}] ${v.title}`);
      console.log(`    desc: ${v.description}`);
      console.log(`    fix:  ${v.fix_instruction}`);
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
