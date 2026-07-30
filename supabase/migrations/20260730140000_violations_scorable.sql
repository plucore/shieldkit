-- ============================================================
-- violations.scorable — record whether a check counted toward the score
--
-- WHY. `scorable` is a transient in-memory hint on CheckResult and was never
-- persisted, so the stored row for an unmeasurable check is byte-identical to a
-- genuine pass: passed = true, severity = 'info'. The compliance_score is
-- computed correctly over the scorable subset (isScorable in
-- checks/compliance-score.ts excludes severity='error' AND scorable=false), but
-- scans.total_checks / passed_checks are raw tallies over all twelve, so the
-- two disagree on any scan where something was non-scorable and SQL cannot tell
-- which rows were excluded.
--
-- That gap is not academic: on 2026-07-29 it produced a false positive in an
-- audit of this very database. page_speed showed 45 passes and 0 failures with
-- passed_checks = 10 / total_checks = 12, which reads as a check that always
-- passes and inflates the score by ~8 points. It does neither — the stored
-- compliance_score of 81.82 is 9/11, not 10/12 (83.33) — but proving that took
-- reconstructing the arithmetic by hand because the excluded row was invisible.
--
-- WHAT IS STORED. The EFFECTIVE scorability, i.e. isScorable(result): false for
-- both an errored check and an explicitly non-scorable one. That makes
-- `count(*) FILTER (WHERE scorable)` per scan reproduce the score's denominator
-- exactly, from one source of truth rather than a second rule that can drift.
--
-- NULLABLE, NO BACKFILL. NULL means "written before this migration"; it is
-- deliberately NOT defaulted to true, because guessing at history is what the
-- column exists to stop. Every row written from now on gets an explicit boolean.
--
-- DELIBERATELY NOT CHANGING scans.total_checks / passed_checks. ScoreTrend
-- computes issues-fixed as (total_checks - passed_checks), which is CORRECT
-- precisely because a non-scorable check is counted in both terms and cancels.
-- Redefining either column would silently change the meaning of every
-- historical row and break that subtraction.
-- ============================================================
ALTER TABLE violations
  ADD COLUMN IF NOT EXISTS scorable BOOLEAN;

COMMENT ON COLUMN violations.scorable IS
  'Effective scorability (isScorable): did this row count toward compliance_score? '
  'false for errored or unmeasurable checks. NULL = written before 2026-07-30, unknown.';
