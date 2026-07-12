-- supabase/migrations/20260712000000_atomic_generation_caps.sql
--
-- Race-safe generation caps (SHIELDKIT-2 — 2026-07-12).
--
-- Two AI-generation caps were enforced non-atomically (count-then-write), so
-- concurrent submits — e.g. an ungated generation button firing several POSTs
-- before it locked — could each read "under cap" before any write landed and
-- all pass the check (TOCTOU). Observed live: 5 appeal letters generated for a
-- single scan despite the 3-per-scan cap.
--
-- These RPCs make both caps atomic, mirroring the existing
-- decrement_scan_quota / consume_ai_credit pattern.
--
--   insert_appeal_letter_if_under_cap(merchant, scan, cap)
--     Per-scan advisory lock -> count -> reserve-insert only when under cap.
--     Returns the reserved row id so the route can finalize it with the letter
--     after generation (and delete it on failure). Concurrent callers for the
--     same scan serialize on the lock, so the cap can never be exceeded.
--
--   finalize_policy_regen(merchant, type, body)
--     Atomically claims the single per-type policy regeneration AND writes the
--     new body in ONE conditional UPDATE (row lock). Because the claim and the
--     content write are the same statement, a crash before it leaves the regen
--     unspent (no "burned a regen with no policy" edge), and two concurrent
--     regens can't both win. Called AFTER generation, so there's no claim to
--     release on failure.

BEGIN;

-- Supersede the earlier claim/release pair (claim-before-generation) with the
-- single-statement finalize below. Safe no-op on a fresh bootstrap.
DROP FUNCTION IF EXISTS claim_policy_regen(UUID, TEXT);
DROP FUNCTION IF EXISTS release_policy_regen(UUID, TEXT);

-- ── Appeal-letter per-scan cap ────────────────────────────────────────────
-- Reserves a slot by inserting a placeholder row (generated_letter NULL) that
-- the caller finalizes with the real letter, or deletes on failure. Counting
-- the in-flight reservation is what makes the cap correct under concurrency.
-- Abandoned reservations (a crash between reserve and finalize) older than 10
-- minutes are reclaimed here so a leaked NULL row can't permanently consume a
-- cap slot.
CREATE OR REPLACE FUNCTION insert_appeal_letter_if_under_cap(
  p_merchant_id UUID,
  p_scan_id     UUID,
  p_cap         INT
)
RETURNS TABLE(accepted BOOLEAN, letter_id UUID, used_count INT) AS $$
DECLARE
  v_count INT;
  v_id    UUID;
BEGIN
  -- Serialize concurrent callers for this scan for the rest of the txn.
  PERFORM pg_advisory_xact_lock(hashtext(p_scan_id::text));

  DELETE FROM appeal_letters
  WHERE scan_id = p_scan_id
    AND generated_letter IS NULL
    AND created_at < now() - INTERVAL '10 minutes';

  SELECT count(*) INTO v_count
  FROM appeal_letters
  WHERE scan_id = p_scan_id;

  IF v_count >= p_cap THEN
    accepted := false;
    letter_id := NULL;
    used_count := v_count;
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO appeal_letters (merchant_id, scan_id)
  VALUES (p_merchant_id, p_scan_id)
  RETURNING id INTO v_id;

  accepted := true;
  letter_id := v_id;
  used_count := v_count + 1;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql;

-- ── Policy per-type regen cap ─────────────────────────────────────────────
-- Claims the single regeneration allowed per policy type AND stores the new
-- body in one atomic conditional UPDATE (row lock). Sets both columns only when
-- a base policy already exists AND the regen has NOT been used. Returns one row
-- when the claim succeeds, zero rows otherwise (already regenerated — the
-- caller discards the loser's output; the winner's body stays). Called after
-- generation, so a crash before this statement leaves the regen unspent.
CREATE OR REPLACE FUNCTION finalize_policy_regen(
  p_merchant_id UUID,
  p_type        TEXT,
  p_body        TEXT
)
RETURNS TABLE(claimed BOOLEAN) AS $$
  UPDATE merchants
  SET generated_policies = jsonb_set(
        COALESCE(generated_policies, '{}'::jsonb),
        ARRAY[p_type],
        to_jsonb(p_body),
        true),
      policy_regen_used = jsonb_set(
        COALESCE(policy_regen_used, '{}'::jsonb),
        ARRAY[p_type],
        'true'::jsonb,
        true)
  WHERE id = p_merchant_id
    AND COALESCE((policy_regen_used ->> p_type)::boolean, false) = false
    AND COALESCE(generated_policies ->> p_type, '') <> ''
  RETURNING true AS claimed;
$$ LANGUAGE sql;

COMMIT;

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- BEGIN;
-- DROP FUNCTION IF EXISTS insert_appeal_letter_if_under_cap(UUID, UUID, INT);
-- DROP FUNCTION IF EXISTS finalize_policy_regen(UUID, TEXT, TEXT);
-- COMMIT;
