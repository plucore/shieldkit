/**
 * app/routes/api.cron.weekly-scan.ts
 *
 * POST /api/cron/weekly-scan
 *
 * Triggered by Vercel Cron every Monday at 8am UTC.
 *
 * Vercel Hobby tier caps function duration at 60s, so this route does NOT
 * run the scans itself. Instead it enqueues one `pending_scan_triggers` row
 * per active monitoring-access merchant (MONITORING_TIERS = monitoring,
 * recovery, grandfathered pro). The actual scans are drained by
 * `api.cron.process-scan-triggers.ts`, which a GitHub Actions workflow
 * curls every 30 minutes (one merchant per invocation, ~12s each).
 *
 * Flow:
 *   1. Verify CRON_SECRET bearer token.
 *   2. Fetch active merchants whose tier is in MONITORING_TIERS.
 *   3. Upsert one trigger row per merchant with trigger_type='weekly_scan'
 *      and week_iso = current ISO week. The (merchant_id, trigger_type,
 *      week_iso) partial unique index makes a double-fire a no-op rather
 *      than a duplicate-scan storm (Fix 8 — 2026-05-27 audit).
 *   4. Return count of triggers queued.
 *
 * Completes in 1–3 seconds even at 1000 merchants.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { supabase } from "../supabase.server";
import { PAID_TIERS } from "../lib/billing/plans";

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
    .in("tier", PAID_TIERS as readonly string[])
    .is("uninstalled_at", null);

  if (fetchError) {
    console.error("[cron/weekly-scan] Failed to fetch merchants:", fetchError.message);
    return json({ error: "database_error", message: "Could not fetch merchants." }, 500);
  }

  if (!merchants || merchants.length === 0) {
    return json({ triggers_queued: 0 });
  }

  // ── 3. Enqueue one trigger per merchant (idempotent on ISO week) ────────────
  // week_iso stamps every weekly-cron row. The partial unique index on
  // (merchant_id, trigger_type, week_iso) WHERE week_iso IS NOT NULL means
  // a Vercel retry or manual replay within the same ISO week is a no-op
  // rather than a duplicate scan storm. Event-driven inserts (theme update,
  // product update, enrichment) leave week_iso NULL and use their own dedup.
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const weekIso = isoWeekKey(nowDate);

  const rows = merchants.map((m: { id: string }) => ({
    merchant_id: m.id,
    trigger_type: "weekly_scan",
    trigger_at: now,
    week_iso: weekIso,
  }));

  const { error: insertError } = await supabase
    .from("pending_scan_triggers")
    .upsert(rows, {
      onConflict: "merchant_id,trigger_type,week_iso",
      ignoreDuplicates: true,
    });

  if (insertError) {
    console.error(
      "[cron/weekly-scan] Failed to enqueue triggers:",
      insertError.message,
    );
    return json({ error: "database_error", message: insertError.message }, 500);
  }

  return json({ triggers_queued: rows.length, week_iso: weekIso });
}

/**
 * ISO week key like "2026-W22". Inline because date-fns isn't a dep and a
 * single-purpose helper is cheaper than pulling one in (per CLAUDE.md's
 * 2026-05-21 outage retrospective on transitive dep bloat).
 *
 * Computes ISO-8601 week number: weeks start Monday, week 1 contains the
 * year's first Thursday. The algorithm is the standard "find Thursday in
 * the same week, then count Thursdays from Jan 4".
 */
function isoWeekKey(d: Date): string {
  // Clone so we don't mutate caller's Date.
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // ISO weeks: day 1 = Monday, day 7 = Sunday. Shift Sunday from 0 to 7.
  const dayNum = date.getUTCDay() || 7;
  // Set to the nearest Thursday: current date + 4 - current day number.
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  // Year of that Thursday is the ISO-week year.
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(
    ((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}
