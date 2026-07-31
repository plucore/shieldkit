/**
 * app/routes/api.cron.measure-page-speed.ts
 * Route: /api/cron/measure-page-speed   (GET + POST, bearer CRON_SECRET)
 *
 * Drains `pending_scan_triggers` rows of trigger_type 'page_speed', calls
 * PageSpeed Insights on THIS invocation's 60s budget, and patches the
 * placeholder violation row the scan wrote.
 *
 * ── WHY A DEDICATED ROUTE, NOT api.cron.process-scan-triggers ───────────────
 *
 * Two reasons, both about protecting paying merchants:
 *
 *  1. BUDGET. A single PSI call can legitimately take 45s. The enrichment
 *     drainer runs a worker pool inside a 45s budget; admitting one PSI call
 *     would let a free merchant's page-speed measurement starve a paying
 *     merchant's catalog enrichment for an entire invocation.
 *  2. TIER. The drainer's SELECT is deliberately restricted to PAID merchants
 *     (`.in("merchants.tier", PAID_TIERS)`) — that filter is the fix for a
 *     documented poison-pill incident and must not be widened. But page_speed
 *     is part of the FREE 12-point scan too, so its queue has to be readable
 *     for free merchants. A separate query keeps the drainer's filter exactly
 *     as it is.
 *
 * ── WHY PATCHING IS SAFE ────────────────────────────────────────────────────
 *
 * page_speed is permanently non-scorable (`scorable: false` on every path in
 * page-speed.server.ts), so it is in neither the numerator nor the denominator
 * of compliance_score. A result landing after the merchant has already seen
 * their score therefore CANNOT change that score — the denominator is 11 either
 * way, and there is no recompute path because there is nothing to recompute.
 *
 * The raw tallies `scans.passed_checks` / `info_count` DO move (they count all
 * 12 results, including non-scorable ones), so they are recomputed from the
 * violation rows here. `compliance_score` and `total_checks` are never touched.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { supabase } from "../supabase.server";
import { sentry } from "../lib/sentry.server";
import { recordCronRun } from "../lib/cron-runs.server";
import {
  measurePageSpeed,
  PAGE_SPEED_CHECK_NAME,
  PAGE_SPEED_TRIGGER,
  PAGE_SPEED_TIMEOUT_MS,
} from "../lib/checks/page-speed.server";

/**
 * Rows measured per invocation. Deliberately small: each is one PSI call of up
 * to PAGE_SPEED_TIMEOUT_MS, and the function ceiling is 60s. The schedule
 * (every 30 min via GitHub Actions) gives ~48 measurements/day against a scan
 * volume in the single digits, so a cap of 1 keeps up with room to spare while
 * making it impossible to exceed the ceiling.
 */
const ROWS_PER_RUN = 1;

function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// GET (Vercel Cron) and POST (GitHub Actions) both delegate to run(). The
// bearer check inside run() is the only authorisation gate — never the verb.
// See the cron HTTP-method note in claude.md §7.
export async function loader({ request }: LoaderFunctionArgs) {
  return run(request);
}

export async function action({ request }: ActionFunctionArgs) {
  return run(request);
}

interface PageSpeedTriggerRow {
  id: number;
  merchant_id: string;
  payload: { scan_id?: string; store_url?: string } | null;
}

async function run(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[cron/measure-page-speed] CRON_SECRET env var is not set");
    return json({ error: "server_config_error" }, 500);
  }
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (token !== cronSecret) {
    return json({ error: "unauthorized" }, 401);
  }

  const startedAt = Date.now();
  let summary: Record<string, unknown>;
  let ok = true;
  let status = 200;
  try {
    summary = await measurePending();
  } catch (err) {
    ok = false;
    status = 500;
    const message = err instanceof Error ? err.message : String(err);
    console.error("[cron/measure-page-speed] run failed:", message);
    await sentry.captureException(err, { tags: { area: "cron.measure-page-speed" } });
    summary = { error: "run_failed", message };
  }

  await recordCronRun({ job: "measure-page-speed", startedAt, ok, summary });
  return json(summary, status);
}

async function measurePending(): Promise<Record<string, unknown>> {
  // NOT tier-filtered: page_speed is part of the free 12-point scan too. Still
  // scoped to installed merchants so a uninstalled shop's queue is inert.
  const { data: rows, error: fetchErr } = await supabase
    .from("pending_scan_triggers")
    .select("id, merchant_id, payload, merchants!inner(uninstalled_at)")
    .eq("trigger_type", PAGE_SPEED_TRIGGER)
    .is("processed_at", null)
    .is("merchants.uninstalled_at", null)
    .order("trigger_at", { ascending: true })
    .limit(ROWS_PER_RUN);

  if (fetchErr) throw new Error(`trigger fetch failed: ${fetchErr.message}`);

  const triggers = (rows ?? []) as unknown as PageSpeedTriggerRow[];
  if (triggers.length === 0) {
    return { checked: 0, measured: 0, not_measured: 0, patched: 0, skipped: 0 };
  }

  let measured = 0;
  let notMeasured = 0;
  let patched = 0;
  let skipped = 0;
  const timings: number[] = [];

  for (const row of triggers) {
    const scanId = row.payload?.scan_id;
    const storeUrl = row.payload?.store_url;

    // A malformed payload must still advance the row — otherwise it wedges the
    // head of the queue forever (the poison-pill shape the drainer documents).
    if (!scanId || !storeUrl) {
      skipped += 1;
      await markProcessed(row.id);
      continue;
    }

    const result = await measurePageSpeed(storeUrl, PAGE_SPEED_TIMEOUT_MS);
    const raw = (result.raw_data ?? {}) as Record<string, unknown>;
    const wasMeasured = raw.measured === true;
    if (wasMeasured) measured += 1;
    else notMeasured += 1;
    if (typeof raw.elapsed_ms === "number") timings.push(raw.elapsed_ms);

    const { error: patchErr } = await supabase
      .from("violations")
      .update({
        passed: result.passed,
        severity: result.severity,
        title: result.title,
        description: result.description,
        fix_instruction: result.fix_instruction,
        raw_data: result.raw_data,
        // Stays false on every path — this check is permanently advisory, which
        // is precisely what makes patching it score-neutral.
        scorable: false,
      })
      .eq("scan_id", scanId)
      .eq("check_name", PAGE_SPEED_CHECK_NAME);

    if (patchErr) {
      // Leave the trigger UNPROCESSED so the next run retries the patch. The
      // PSI call is cheap to repeat; losing the result is not.
      console.error(
        `[cron/measure-page-speed] patch failed for scan ${scanId}: ${patchErr.message}`,
      );
      continue;
    }

    patched += 1;
    await syncScanTallies(scanId);
    await markProcessed(row.id);
  }

  return {
    checked: triggers.length,
    measured,
    not_measured: notMeasured,
    patched,
    skipped,
    elapsed_ms_samples: timings,
  };
}

/**
 * Recompute the raw per-scan tallies after a patch.
 *
 * `passed_checks` and `info_count` count ALL twelve results (including
 * non-scorable ones), so a page_speed row flipping passed true -> false leaves
 * them stale. `compliance_score` and `total_checks` are deliberately NOT
 * touched: the score excludes this check entirely, and total_checks is a
 * constant 12 that ScoreTrend's (total - passed) subtraction depends on.
 */
async function syncScanTallies(scanId: string): Promise<void> {
  const { data: rows, error } = await supabase
    .from("violations")
    .select("passed, severity, check_name")
    .eq("scan_id", scanId);

  if (error || !rows) return;

  const all = rows as Array<{ passed: boolean; severity: string; check_name: string }>;
  // The synthetic scan_data_availability marker is not one of the 12 checks.
  const checks = all.filter((r) => r.check_name !== "scan_data_availability");
  const failed = checks.filter((r) => !r.passed);

  await supabase
    .from("scans")
    .update({
      passed_checks: checks.filter((r) => r.passed).length,
      critical_count: failed.filter((r) => r.severity === "critical").length,
      warning_count: failed.filter((r) => r.severity === "warning").length,
      info_count: failed.filter((r) => r.severity === "info").length,
    })
    .eq("id", scanId);
}

async function markProcessed(id: number): Promise<void> {
  const { error } = await supabase
    .from("pending_scan_triggers")
    .update({ processed_at: new Date().toISOString() })
    .eq("id", id);
  if (error) {
    console.error(
      `[cron/measure-page-speed] failed to mark trigger ${id} processed: ${error.message}`,
    );
  }
}
