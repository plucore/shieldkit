/**
 * app/routes/api.cron.weekly-scan.ts
 *
 * POST /api/cron/weekly-scan
 *
 * Automated weekly compliance scan for all active Pro merchants.
 * Triggered by Vercel Cron every Monday at 8am UTC.
 *
 * Flow:
 *   1. Verify CRON_SECRET bearer token.
 *   2. Fetch all active Pro merchants.
 *   3. Run compliance scans sequentially (2s delay between each).
 *   4. Compare each scan against the merchant's previous scan.
 *   5. Send alert email if score dropped or new critical/warning issues appeared.
 *   6. Return summary JSON.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { supabase } from "../supabase.server";
import { runComplianceScan } from "../lib/compliance-scanner.server";
import { compareScanWithPrevious } from "../lib/scan-comparison.server";

function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function loader(_args: LoaderFunctionArgs) {
  return json({ error: "method_not_allowed", message: "Use POST /api/cron/weekly-scan." }, 405);
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed", message: "Use POST." }, 405);
  }

  // ── 1. Verify CRON_SECRET ────────────────────────────────────────────────────
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[cron/weekly-scan] CRON_SECRET env var is not set");
    return json({ error: "server_config_error", message: "CRON_SECRET not configured." }, 500);
  }

  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (token !== cronSecret) {
    return json({ error: "unauthorized", message: "Invalid or missing authorization." }, 401);
  }

  // ── 2. Fetch all active Pro merchants ────────────────────────────────────────
  const { data: merchants, error: fetchError } = await supabase
    .from("merchants")
    .select("id, shopify_domain")
    .eq("tier", "pro")
    .is("uninstalled_at", null);

  if (fetchError) {
    console.error("[cron/weekly-scan] Failed to fetch merchants:", fetchError.message);
    return json({ error: "database_error", message: "Could not fetch merchants." }, 500);
  }

  if (!merchants || merchants.length === 0) {
    return json({ merchants_scanned: 0, alerts_sent: 0, errors: 0 });
  }

  // ── 3. Process merchants sequentially ────────────────────────────────────────
  let merchantsScanned = 0;
  let alertsSent = 0;
  let errors = 0;

  for (const merchant of merchants) {
    try {
      // Run automated scan
      const scanResult = await runComplianceScan(
        merchant.id,
        merchant.shopify_domain,
        "automated"
      );
      merchantsScanned++;

      // ── 4. Compare against previous scan ───────────────────────────────────
      const comparison = await compareScanWithPrevious(
        merchant.id,
        scanResult.scan,
        scanResult.violations,
      );

      if (comparison?.shouldAlert) {
        console.log(
          `[cron/weekly-scan] Alert condition met for ${merchant.shopify_domain}: ` +
          `score ${comparison.oldScore} → ${comparison.newScore}, ` +
          `${comparison.newIssues.length} new issue(s)`
        );
        alertsSent++;
      }
    } catch (err) {
      errors++;
      console.error(
        `[cron/weekly-scan] Scan failed for ${merchant.shopify_domain}:`,
        err instanceof Error ? err.message : err,
      );
    }

    // 2-second delay between merchants to avoid Shopify rate limits
    await sleep(2000);
  }

  return json({ merchants_scanned: merchantsScanned, alerts_sent: alertsSent, errors });
}
