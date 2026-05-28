-- supabase/migrations/20260528121738_ai_usage_cap.sql
--
-- v4 AI usage cap (§5 — 2026-05-28). Counts AI generations per merchant
-- per rolling 30-day window. The cap is 12 (AI_MONTHLY_CAP in
-- app/lib/ai-usage.server.ts), shared across policy generation and GMC
-- appeal-letter generation.
--
-- This is the OUTER ceiling. Per-type policy regen (`policy_regen_used`,
-- 2/type) and per-scan appeal limits (3/scan) still apply as UX nudges
-- inside this monthly budget.
--
-- New columns:
--   ai_generations_used        — increments by 1 on every successful
--                                hit to Anthropic. Atomic via the
--                                accompanying RPC.
--   ai_generations_reset_at    — set to now() the moment the merchant's
--                                window started. When age > 30 days the
--                                checkAndConsumeAiCredit function resets
--                                count to 0 and stamps reset_at = now().
--
-- The RPC `consume_ai_credit(p_merchant_id UUID, p_cap INT)` performs
-- the read-reset-increment-or-deny in a single SQL statement so two
-- parallel requests can't race past the cap.

BEGIN;

ALTER TABLE merchants
  ADD COLUMN IF NOT EXISTS ai_generations_used INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ai_generations_reset_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Atomic counter. Returns one row on success with the new counter value;
-- returns zero rows when the merchant has already exhausted the cap.
-- The age check (>=30 days since reset_at) resets BEFORE the increment so
-- a long-dormant merchant doesn't get blocked by stale state.
CREATE OR REPLACE FUNCTION consume_ai_credit(p_merchant_id UUID, p_cap INT)
RETURNS TABLE(new_used INT, reset_at TIMESTAMPTZ) AS $$
  UPDATE merchants
  SET
    ai_generations_used = CASE
      WHEN ai_generations_reset_at < now() - INTERVAL '30 days' THEN 1
      ELSE ai_generations_used + 1
    END,
    ai_generations_reset_at = CASE
      WHEN ai_generations_reset_at < now() - INTERVAL '30 days' THEN now()
      ELSE ai_generations_reset_at
    END
  WHERE id = p_merchant_id
    AND (
      ai_generations_reset_at < now() - INTERVAL '30 days'
      OR ai_generations_used < p_cap
    )
  RETURNING ai_generations_used AS new_used,
            ai_generations_reset_at AS reset_at;
$$ LANGUAGE sql;

COMMIT;

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- BEGIN;
-- DROP FUNCTION IF EXISTS consume_ai_credit(UUID, INT);
-- ALTER TABLE merchants
--   DROP COLUMN IF EXISTS ai_generations_used,
--   DROP COLUMN IF EXISTS ai_generations_reset_at;
-- COMMIT;
