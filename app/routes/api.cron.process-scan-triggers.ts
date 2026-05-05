/**
 * app/routes/api.cron.process-scan-triggers.ts
 *
 * POST /api/cron/process-scan-triggers
 *
 * Phase 7.3 — Drains pending_scan_triggers, runs the 12-point compliance
 * scan once per affected merchant (regardless of how many trigger rows
 * are queued for that merchant), then marks all of that merchant's
 * pending rows processed_at=NOW().
 *
 * Hobby-tier Vercel Cron min frequency = 1/day, so this fires daily at
 * 12:00 UTC. Triggers older than 24h will be picked up the next tick.
 *
 * Auth: bearer CRON_SECRET, mirrors api.cron.weekly-scan.ts.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { supabase } from "../supabase.server";
import { runComplianceScan } from "../lib/compliance-scanner.server";

const BATCH_SIZE = 50;
const MERCHANT_DELAY_MS = 2000;

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

    await sleep(MERCHANT_DELAY_MS);
  }

  return json({
    merchants_scanned: merchantsScanned,
    triggers_processed: triggersProcessed,
    errors,
  });
}
