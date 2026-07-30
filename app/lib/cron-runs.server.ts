/**
 * app/lib/cron-runs.server.ts
 *
 * Append-only "this job ran" ledger. See
 * supabase/migrations/20260730130000_cron_runs.sql for why it is a separate
 * table from webhook_failures and why it is FK-free.
 *
 * The problem it solves: api.cron.reconcile-installs is non-destructive by
 * design and therefore persists nothing at all, and Vercel Hobby keeps runtime
 * logs for about an hour. On 2026-07-30 a two-hour log window returned four
 * lines, so "has reconcile-installs ever run?" was unanswerable. The only cron
 * we could prove was running (reconcile-catalog) was provable purely because it
 * writes catalog_reconcile_state as a side effect of its actual job.
 * Observability should not be an accident of what a job happens to persist.
 *
 * Never throws: a bookkeeping failure must not fail the cron whose success it
 * is recording.
 */

import { supabase } from "../supabase.server";

export async function recordCronRun(args: {
  /** Route slug, e.g. "reconcile-installs". */
  job: string;
  /** Date.now() captured when the work started. */
  startedAt: number;
  ok: boolean;
  summary: Record<string, unknown>;
}): Promise<void> {
  try {
    await supabase.from("cron_runs").insert({
      job: args.job,
      duration_ms: Math.max(0, Date.now() - args.startedAt),
      ok: args.ok,
      summary: args.summary,
    });
  } catch (err) {
    console.warn(
      `[cron-runs] failed to record run for ${args.job}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
