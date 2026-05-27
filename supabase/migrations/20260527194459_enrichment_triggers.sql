-- supabase/migrations/20260527194459_enrichment_triggers.sql
--
-- Move per-product GTIN/MPN/brand enrichment off the products/update
-- webhook hot path (Fix 9 — 2026-05-27 audit). The webhook handler had a
-- 3-second inline budget but the full path (Supabase dedup query + Admin
-- API metafieldsSet call + audit insert) routinely exceeded Shopify's ~5s
-- webhook timeout, generating retries and possibly silent enrichment loss.
--
-- Solution: webhook enqueues a pending_scan_triggers row with
-- trigger_type='enrichment' and the product gid in a new payload JSONB
-- column. The existing drainer (api.cron.process-scan-triggers.ts) picks
-- it up next tick and runs the enrichment with the full 60s function
-- ceiling to work with.
--
-- New column: payload JSONB — generic so future trigger types can carry
-- whatever per-event context they need without further schema changes.

BEGIN;

ALTER TABLE pending_scan_triggers
  ADD COLUMN IF NOT EXISTS payload JSONB;

-- Documenting the expanded trigger_type vocabulary so future readers
-- understand what values are valid.
COMMENT ON COLUMN pending_scan_triggers.trigger_type IS
  'Trigger type. Values: weekly_scan, theme_update, theme_publish, product_update, enrichment.';

COMMENT ON COLUMN pending_scan_triggers.payload IS
  'Per-trigger context. Only set for enrichment today — { product_gid, numeric_product_id }.';

COMMIT;

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- BEGIN;
-- ALTER TABLE pending_scan_triggers DROP COLUMN IF EXISTS payload;
-- COMMIT;
