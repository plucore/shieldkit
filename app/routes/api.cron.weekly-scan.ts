/**
 * app/routes/api.cron.weekly-scan.ts
 *
 * POST /api/cron/weekly-scan
 *
 * Triggered by Vercel Cron every Monday at 8am UTC.
 *
 * Vercel Hobby tier caps function duration at 60s, so this route does NOT
 * run the scans itself. Instead it enqueues one `pending_scan_triggers` row
 * per active paid merchant. The actual scans are drained by
 * `api.cron.process-scan-triggers.ts`, which a GitHub Actions workflow
 * curls every 5 minutes (one merchant per invocation, ~12s each).
 *
 * Flow:
 *   1. Verify CRON_SECRET bearer token.
 *   2. Fetch all active paid merchants (tier IN ('shield','pro')).
 *   3. Bulk-insert one trigger row per merchant with trigger_type='weekly_scan'.
 *   4. Return count of triggers queued.
 *
 * This completes in 1–3 seconds even at 1000 merchants.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { supabase } from "../supabase.server";
import { MONITORING_TIERS } from "../lib/billing/plans";

function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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

  // ── 2. Fetch all active monitoring-tier merchants ────────────────────────
  // MONITORING_TIERS centralises which DB tier values get the weekly scan
  // pipeline — currently monitoring + recovery + grandfathered pro. The
  // 2 live Shield Max customers (tier='pro') are included.
  const { data: merchants, error: fetchError } = await supabase
    .from("merchants")
    .select("id")
    .in("tier", MONITORING_TIERS as readonly string[])
    .is("uninstalled_at", null);

  if (fetchError) {
    console.error("[cron/weekly-scan] Failed to fetch merchants:", fetchError.message);
    return json({ error: "database_error", message: "Could not fetch merchants." }, 500);
  }

  if (!merchants || merchants.length === 0) {
    return json({ triggers_queued: 0 });
  }

  // ── 3. Enqueue one trigger per merchant ─────────────────────────────────────
  const now = new Date().toISOString();
  const rows = merchants.map((m) => ({
    merchant_id: m.id,
    trigger_type: "weekly_scan",
    trigger_at: now,
  }));

  const { error: insertError } = await supabase
    .from("pending_scan_triggers")
    .insert(rows);

  if (insertError) {
    console.error(
      "[cron/weekly-scan] Failed to enqueue triggers:",
      insertError.message,
    );
    return json({ error: "database_error", message: insertError.message }, 500);
  }

  return json({ triggers_queued: rows.length });
}
