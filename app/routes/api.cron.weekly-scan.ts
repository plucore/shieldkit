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
import { sendComplianceAlertEmail } from "../utils/email.server";

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
      // Fetch the most recent scan BEFORE this one (the second-newest)
      const { data: previousScans } = await supabase
        .from("scans")
        .select("id, compliance_score, critical_count, warning_count")
        .eq("merchant_id", merchant.id)
        .neq("id", scanResult.scan.id)
        .order("created_at", { ascending: false })
        .limit(1);

      const previousScan = previousScans?.[0] ?? null;

      if (previousScan) {
        const oldScore = previousScan.compliance_score ?? 100;
        const newScore = scanResult.scan.compliance_score;
        const scoreDropped = newScore < oldScore;

        // Find new failed checks that weren't failing before
        let newIssues: Array<{ check_name: string; severity: string; title: string }> = [];

        if (previousScan.id) {
          const { data: oldViolations } = await supabase
            .from("violations")
            .select("check_name, passed")
            .eq("scan_id", previousScan.id);

          const oldFailedChecks = new Set(
            (oldViolations ?? [])
              .filter((v: { passed: boolean }) => !v.passed)
              .map((v: { check_name: string }) => v.check_name)
          );

          newIssues = scanResult.violations
            .filter((v) => !v.passed && !oldFailedChecks.has(v.check_name))
            .filter((v) => v.severity === "critical" || v.severity === "warning")
            .map((v) => ({
              check_name: v.check_name,
              severity: v.severity,
              title: v.title ?? v.check_name.replace(/_/g, " "),
            }));
        }

        const shouldAlert = scoreDropped || newIssues.length > 0;

        if (shouldAlert) {
          // Look up merchant email via shop info in leads table
          const { data: lead } = await supabase
            .from("leads")
            .select("email")
            .eq("shop_domain", merchant.shopify_domain)
            .maybeSingle();

          if (lead?.email) {
            try {
              await sendComplianceAlertEmail(
                lead.email,
                merchant.shopify_domain,
                oldScore,
                newScore,
                newIssues,
              );
              alertsSent++;
            } catch (emailErr) {
              console.error(
                `[cron/weekly-scan] Failed to send alert for ${merchant.shopify_domain}:`,
                emailErr instanceof Error ? emailErr.message : emailErr,
              );
            }
          }
        }
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
