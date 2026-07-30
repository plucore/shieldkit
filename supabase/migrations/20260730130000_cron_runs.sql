-- ============================================================
-- cron_runs — did the job actually run, and what did it do?
--
-- WHY A NEW TABLE RATHER THAN REUSING webhook_failures
--
-- webhook_failures is an audit + retry queue for webhook deliveries whose
-- side-effect WRITES failed. Its semantics are already easy to misread —
-- claude.md §11 has to spell out that "empty means no Supabase write ever
-- errored, NOT that no webhook ever failed". Pouring successful cron runs into
-- it would make that ambiguity permanent, pollute the
-- idx_webhook_failures_unresolved hot set that operators page off, and give a
-- row-per-success to a table whose only index assumes rows are exceptional.
-- Two different questions ("did a write fail?" / "did a job run?") deserve two
-- tables.
--
-- WHY IT IS NEEDED AT ALL
--
-- api.cron.reconcile-installs deliberately persists NOTHING: it is
-- non-destructive by design and a 401/403 produces only a console line and a
-- Sentry breadcrumb. Combined with Vercel Hobby's ~1h runtime-log retention,
-- there is no way — none — to answer "has reconcile-installs ever run?". On
-- 2026-07-30 a 2-hour log window returned 4 lines total, so even yesterday was
-- already unreachable. Meanwhile reconcile-catalog IS provably running purely
-- because it happens to write catalog_reconcile_state as a side effect of its
-- real job. Observability should not be an accident of what a job persists.
--
-- FK-free on purpose, same reasoning as install_events: this table outlives the
-- rows a run touched, and a future "tidy-up" adding a foreign key would delete
-- the operational history on the next shop/redact cascade.
--
-- One row per completed invocation, written at the END, so a row can never be
-- half-populated and a missing row means the job did not finish.
-- ============================================================
CREATE TABLE IF NOT EXISTS cron_runs (
  id BIGSERIAL PRIMARY KEY,
  -- Route slug, e.g. 'reconcile-installs'. Not an enum: adding a job must not
  -- require a migration.
  job TEXT NOT NULL,
  ran_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_ms INTEGER,
  ok BOOLEAN NOT NULL DEFAULT true,
  -- Whatever the job already returns in its JSON response. Keeping it as the
  -- same shape means the table needs no schema change when a job's counters do.
  summary JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- "When did <job> last run, and what did the last N runs do?" — the only
-- access pattern this table has.
CREATE INDEX IF NOT EXISTS idx_cron_runs_job_time ON cron_runs(job, ran_at DESC);

ALTER TABLE cron_runs ENABLE ROW LEVEL SECURITY;
