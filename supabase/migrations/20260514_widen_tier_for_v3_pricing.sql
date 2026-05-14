-- supabase/migrations/20260514_widen_tier_for_v3_pricing.sql
--
-- Widens the merchants.tier CHECK constraint to admit the v3 pricing tiers
-- ('monitoring', 'recovery') alongside the existing values
-- ('free', 'shield', 'pro').
--
-- HYBRID GRANDFATHER APPROACH: existing tier='pro' rows (live Shield Max
-- customers, 2 on 2026-05-14) are NOT migrated. They stay on tier='pro' so
-- their subscriptions reconcile correctly and the in-app feature gates
-- (hasMonitoringAccess + hasRecoveryAccess in app/lib/billing/plans.ts)
-- continue to return true for them.
--
-- New signups land on tier='monitoring' or tier='recovery' via the
-- billing-confirm loader and the APP_SUBSCRIPTIONS_UPDATE webhook.
--
-- Pre-flight check (run before applying):
--   SELECT tier, COUNT(*) FROM merchants GROUP BY tier;
--   Expected on 2026-05-14: pro=2, free=21. No 'shield' rows.
--
-- This migration is REVERSIBLE — see the rollback block at the end. Do not
-- delete the rollback comment; if a future migration ever has to undo this
-- it must first verify no 'monitoring' or 'recovery' rows exist.

BEGIN;

ALTER TABLE merchants DROP CONSTRAINT IF EXISTS merchants_tier_check;

ALTER TABLE merchants
  ADD CONSTRAINT merchants_tier_check
  CHECK (tier IN ('free', 'shield', 'pro', 'monitoring', 'recovery'));

COMMIT;

-- ── ROLLBACK (manual, only if zero monitoring/recovery rows exist) ──────────
-- BEGIN;
-- ALTER TABLE merchants DROP CONSTRAINT merchants_tier_check;
-- ALTER TABLE merchants
--   ADD CONSTRAINT merchants_tier_check
--   CHECK (tier IN ('free', 'shield', 'pro'));
-- COMMIT;
