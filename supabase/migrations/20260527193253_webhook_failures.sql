-- supabase/migrations/20260527193253_webhook_failures.sql
--
-- webhook_failures: audit + retry-queue table for webhook deliveries whose
-- DB write side-effects failed. Today only app/uninstalled writes to this
-- table (logged-and-continued silently before Fix 4 — root cause of the
-- inferred ~30% ghost-merchant rate where rows had uninstalled_at = NULL
-- despite the merchant actually being uninstalled on Shopify).
--
-- The accompanying reconciler cron (api.cron.reconcile-installs.ts) walks
-- still-installed merchants daily and confirms via Shopify Admin API that
-- the OAuth token still works. When it doesn't, it back-fills uninstalled_at
-- and inserts a synthetic webhook_failures row stamped `resolved_at = now()`
-- so the audit trail records "we caught this out-of-band, not via webhook".

BEGIN;

CREATE TABLE IF NOT EXISTS webhook_failures (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  topic           TEXT         NOT NULL,
  shop            TEXT         NOT NULL,
  payload         JSONB,
  error_message   TEXT,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Lookup index for the reconciler / triage. Partial — unresolved is the
-- hot set; resolved rows are append-only audit history.
CREATE INDEX IF NOT EXISTS idx_webhook_failures_unresolved
  ON webhook_failures (topic, shop)
  WHERE resolved_at IS NULL;

-- Broad time index for ops dashboards / sentry triage queries.
CREATE INDEX IF NOT EXISTS idx_webhook_failures_created_at
  ON webhook_failures (created_at DESC);

COMMIT;

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- BEGIN;
-- DROP INDEX IF EXISTS idx_webhook_failures_created_at;
-- DROP INDEX IF EXISTS idx_webhook_failures_unresolved;
-- DROP TABLE IF EXISTS webhook_failures;
-- COMMIT;
