-- supabase/migrations/20260527194303_pending_scan_triggers_idempotency.sql
--
-- Idempotency guard for the weekly-scan enqueue. The cron at
-- api.cron.weekly-scan.ts inserts one row per paid merchant per Monday;
-- without a uniqueness constraint, a Vercel retry or manual replay would
-- double-enqueue and the drainer would run a redundant scan for every
-- merchant.
--
-- New column: week_iso identifies the ISO-week the trigger belongs to
-- (e.g. "2026-W22"). Only the weekly cron writes this — event-driven
-- inserts (theme update, product update, enrichment from Fix 9) leave it
-- NULL because they're per-event, not per-week.
--
-- New partial unique index covers (merchant_id, trigger_type, week_iso)
-- WHERE week_iso IS NOT NULL. The partial predicate excludes event-driven
-- rows from the constraint so they can dedup on their own existing logic
-- (the 24h "already queued" check in the webhook handlers).
--
-- Cron `.upsert(rows, { onConflict: '...,...,...', ignoreDuplicates: true })`
-- will then make double-firing a no-op rather than a duplicate-scan storm.

BEGIN;

ALTER TABLE pending_scan_triggers
  ADD COLUMN IF NOT EXISTS week_iso TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_scan_triggers_week
  ON pending_scan_triggers (merchant_id, trigger_type, week_iso)
  WHERE week_iso IS NOT NULL;

COMMIT;

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- BEGIN;
-- DROP INDEX IF EXISTS uq_pending_scan_triggers_week;
-- ALTER TABLE pending_scan_triggers DROP COLUMN IF EXISTS week_iso;
-- COMMIT;
