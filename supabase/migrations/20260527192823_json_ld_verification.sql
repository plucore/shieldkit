-- supabase/migrations/20260527192823_json_ld_verification.sql
--
-- JSON-LD activation verification. Splits the existing single
-- merchants.json_ld_enabled flag (merchant intent — set the instant the
-- merchant clicks Enable) from the verified state.
--
-- New columns:
--   json_ld_enable_clicked_at       — set on "Enable JSON-LD" button click
--   json_ld_verified_at             — set when the verifier confirms the
--                                     theme block actually renders on the
--                                     storefront
--   json_ld_verification_attempts   — counts attempts so the verifier can
--                                     give up and re-show "Enable JSON-LD"
--                                     after 5 failed checks
--
-- merchants.json_ld_enabled keeps its existing semantics but is now
-- written ONLY by the verifier on positive confirmation. The UI distinguishes
-- three states from these columns:
--   never_clicked   — clicked_at IS NULL                  → show Enable button
--   pending         — clicked_at NOT NULL, verified IS NULL → show "verifying"
--   verified        — verified_at NOT NULL                 → show "Active ✓"
--
-- This fix retires the silent-success bug where json_ld_enabled = true was
-- set the instant the merchant clicked Enable, even if they never actually
-- saved the theme block. Inferred 38% activation rate was including merchants
-- who clicked but never installed.

BEGIN;

ALTER TABLE merchants
  ADD COLUMN IF NOT EXISTS json_ld_enable_clicked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS json_ld_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS json_ld_verification_attempts INT NOT NULL DEFAULT 0;

-- Backfill: any row currently flagged json_ld_enabled = true predates the
-- verifier, so we mark them as "clicked + assumed verified" to preserve the
-- existing UI experience until the cron runs and either confirms or resets
-- them. New installs flow through clicked → pending → verified normally.
UPDATE merchants
SET
  json_ld_enable_clicked_at = COALESCE(json_ld_enable_clicked_at, installed_at, now()),
  json_ld_verified_at = COALESCE(json_ld_verified_at, installed_at, now())
WHERE json_ld_enabled = true
  AND json_ld_verified_at IS NULL;

COMMIT;

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- BEGIN;
-- ALTER TABLE merchants
--   DROP COLUMN IF EXISTS json_ld_enable_clicked_at,
--   DROP COLUMN IF EXISTS json_ld_verified_at,
--   DROP COLUMN IF EXISTS json_ld_verification_attempts;
-- COMMIT;
