/**
 * app/routes/api.cron.process-scan-triggers.ts
 *
 * POST /api/cron/process-scan-triggers
 *
 * Drains `pending_scan_triggers` one merchant per invocation. A scan runs
 * ~10–15s; the Vercel Hobby tier function ceiling is 60s, so we cap each
 * invocation at a single merchant to stay safely under the limit.
 *
 * Invocation cadence: a GitHub Actions workflow
 * (`.github/workflows/process-scan-triggers.yml`) curls this endpoint every
 * 5 minutes. That's 288 invocations/day — plenty of headroom to clear the
 * weekly-scan enqueue burst within a few hours, even as the paid-merchant
 * count grows.
 *
 * A daily Vercel Cron at 12:00 UTC also hits this endpoint as a safety net
 * in case GitHub Actions is unavailable.
 *
 * Auth: bearer CRON_SECRET, mirrors api.cron.weekly-scan.ts.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { supabase } from "../supabase.server";
import { runComplianceScan } from "../lib/compliance-scanner.server";

// One merchant per invocation. With a ~12s scan, this stays well under the
// 60s Vercel Hobby ceiling and leaves room for transient slow GraphQL calls.
const BATCH_SIZE = 1;

function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function loader(_args: LoaderFunctionArgs) {
  return json(
    { error: "method_not_allowed", message: "Use POST /api/cron/process-scan-triggers." },
    405,
  );
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed", message: "Use POST." }, 405);
  }

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[cron/process-scan-triggers] CRON_SECRET env var is not set");
    return json({ error: "server_config_error" }, 500);
  }
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (token !== cronSecret) {
    return json({ error: "unauthorized" }, 401);
  }

  // Pull a batch of unprocessed triggers, oldest first.
  const { data: rows, error: fetchErr } = await supabase
    .from("pending_scan_triggers")
    .select("id, merchant_id, trigger_type, trigger_at")
    .is("processed_at", null)
    .order("trigger_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (fetchErr) {
    console.error(
      "[cron/process-scan-triggers] failed to fetch triggers:",
      fetchErr.message,
    );
    return json({ error: "database_error", message: fetchErr.message }, 500);
  }

  if (!rows || rows.length === 0) {
    return json({ merchants_scanned: 0, triggers_processed: 0 });
  }

  // Group triggers by merchant — one scan per merchant per tick.
  const triggersByMerchant = new Map<string, string[]>();
  for (const row of rows as Array<{ id: number; merchant_id: string }>) {
    const list = triggersByMerchant.get(row.merchant_id) ?? [];
    list.push(String(row.id));
    triggersByMerchant.set(row.merchant_id, list);
  }

  // Look up shopify_domain for each merchant in one round-trip.
  const merchantIds = Array.from(triggersByMerchant.keys());
  const { data: merchantRows } = await supabase
    .from("merchants")
    .select("id, shopify_domain, tier, uninstalled_at")
    .in("id", merchantIds);

  const merchantsById = new Map<
    string,
    { shopify_domain: string; tier: string; uninstalled_at: string | null }
  >();
  for (const m of (merchantRows ?? []) as Array<{
    id: string;
    shopify_domain: string;
    tier: string;
    uninstalled_at: string | null;
  }>) {
    merchantsById.set(m.id, {
      shopify_domain: m.shopify_domain,
      tier: m.tier,
      uninstalled_at: m.uninstalled_at,
    });
  }

  let merchantsScanned = 0;
  let errors = 0;
  let triggersProcessed = 0;

  for (const [merchantId, triggerIds] of triggersByMerchant) {
    const merchant = merchantsById.get(merchantId);

    // Defensive: skip uninstalled / unknown merchants but still mark
    // their queued triggers processed so they don't accumulate.
    if (!merchant || merchant.uninstalled_at) {
      try {
        await supabase
          .from("pending_scan_triggers")
          .update({ processed_at: new Date().toISOString() })
          .in("id", triggerIds);
      } catch {
        /* swallow */
      }
      continue;
    }

    try {
      await runComplianceScan(merchantId, merchant.shopify_domain, "automated");
      merchantsScanned++;
    } catch (err) {
      errors++;
      console.error(
        `[cron/process-scan-triggers] scan failed for ${merchant.shopify_domain}:`,
        err instanceof Error ? err.message : err,
      );
      // Fall through — still mark processed so we don't loop forever on a
      // permanently broken merchant.
    }

    try {
      await supabase
        .from("pending_scan_triggers")
        .update({ processed_at: new Date().toISOString() })
        .in("id", triggerIds);
      triggersProcessed += triggerIds.length;
    } catch (err) {
      console.error(
        "[cron/process-scan-triggers] failed to mark processed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  return json({
    merchants_scanned: merchantsScanned,
    triggers_processed: triggersProcessed,
    errors,
  });
}
