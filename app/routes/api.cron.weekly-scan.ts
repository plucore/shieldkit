/**
 * app/routes/api.cron.weekly-scan.ts
 *
 * POST /api/cron/weekly-scan
 *
 * Automated weekly compliance scan for all active Shield Pro / Shield Max
 * merchants (DB tier IN ('shield', 'pro')). Triggered by Vercel Cron every
 * Monday at 8am UTC.
 *
 * Flow:
 *   1. Verify CRON_SECRET bearer token.
 *   2. Fetch all active paid merchants.
 *   3. Run compliance scans sequentially (2s delay between each).
 *   4. Persist results to DB (scans + violations tables).
 *   5. Return summary JSON.
 *
 * Scan results surface on the merchant dashboard via the loader in
 * app._index.tsx (lastAutomatedScan, newAutoIssueCount). Diff vs the prior
 * scan is computed at digest time by api.cron.weekly-digest.ts so we don't
 * need to persist diff fields on the scans table here.
 *
 * TODO(Phase 5): re-introduce a Customer Privacy API status signal once a
 * reliable detection path exists. Shopify Admin GraphQL has no surface for
 * verifying that a merchant's storefront correctly initialises the JS
 * Customer Privacy API; the synthetic EU-IP cookie probe was explicitly
 * cut from v2 in the technical plan. The payment-icon health signal is
 * already produced by check #6 (checkout_transparency) on every scan.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { supabase } from "../supabase.server";
import { runComplianceScan } from "../lib/compliance-scanner.server";

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

  // ── 2. Fetch all active paid merchants (Shield Pro + Shield Max) ─────────────
  const { data: merchants, error: fetchError } = await supabase
    .from("merchants")
    .select("id, shopify_domain")
    .in("tier", ["shield", "pro"])
    .is("uninstalled_at", null);

  if (fetchError) {
    console.error("[cron/weekly-scan] Failed to fetch merchants:", fetchError.message);
    return json({ error: "database_error", message: "Could not fetch merchants." }, 500);
  }

  if (!merchants || merchants.length === 0) {
    return json({ merchants_scanned: 0, errors: 0 });
  }

  // ── 3. Process merchants sequentially ────────────────────────────────────────
  let merchantsScanned = 0;
  let errors = 0;

  for (const merchant of merchants) {
    try {
      await runComplianceScan(
        merchant.id,
        merchant.shopify_domain,
        "automated"
      );
      merchantsScanned++;
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

  return json({ merchants_scanned: merchantsScanned, errors });
}
