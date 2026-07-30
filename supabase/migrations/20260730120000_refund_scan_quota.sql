-- ============================================================
-- refund_scan_quota — the inverse of decrement_scan_quota
--
-- WHY THIS EXISTS
--
-- Both scan entry points refunded a failed scan with an ABSOLUTE write
-- computed from a value read BEFORE the decrement:
--
--     .update({ scans_remaining: (scansRemaining ?? 0) + 1 })
--
-- `scansRemaining` is the pre-decrement value. The RPC had already moved the
-- row to scansRemaining - 1, so restoring should write scansRemaining. Writing
-- scansRemaining + 1 hands back one MORE scan than was consumed, so every
-- failed scan NET-GRANTED a free one.
--
-- Not theoretical. On 2026-07-30 western-grace-collective was granted 1 scan
-- (the DB DEFAULT), ran exactly 1 scan, and sat at scans_remaining = 2.
-- Enumerating every writer of that column — DB default, this decrement, the
-- two refunds, the two terminal-status demotes (which also stamp
-- scans_reset_at, and that row's scans_reset_at still equals created_at), and
-- the paid paths (which write NULL) — leaves the refund expression as the only
-- thing that can produce a 2. 5anabh-da reached 2 successful scans the same
-- way.
--
-- The code's own intent proves it was a slip: api.scan.ts sets the RESPONSE
-- field to `scansRemaining` on the very next line while the DB write says
-- `scansRemaining + 1`. The two disagreed; the response was right.
--
-- THE FIX: relative and conditional, in one statement. The pre-read value
-- never enters the arithmetic, so a stale local read cannot corrupt the row,
-- and concurrent refunds cannot compound.
--
-- THE CAP: p_cap defaults to 1 — the free-tier grant, which is both the
-- `scans_remaining` DB DEFAULT and the value the demote paths write. A
-- merchant can never hold more than their granted allowance no matter how many
-- failures occur.
--
--   LEAST(scans_remaining + 1, GREATEST(p_cap, scans_remaining))
--
-- The GREATEST is load-bearing and is the reason this is not a plain LEAST:
-- a bare LEAST(x + 1, 1) would SLASH a manually-granted 5 down to 1 on the
-- first failed scan — turning a refund into a confiscation. GREATEST pins the
-- ceiling to at least the current value, so the function can raise a row
-- toward the cap but can never lower one. Behaviour:
--
--     0 -> 1   normal refund after a decrement            (the real case)
--     1 -> 1   no-op; this is the 1 -> 2 bug, now impossible
--     4 -> 4   no-op; a manual grant is left intact, never cut
--   NULL       untouched; paid/unlimited merchants are skipped entirely
--
-- Returns the resulting value, or NO ROWS when the merchant does not exist or
-- is unlimited (NULL) — mirroring decrement_scan_quota's contract so callers
-- can treat "zero rows" the same way in both directions.
-- ============================================================
CREATE OR REPLACE FUNCTION refund_scan_quota(
  p_merchant_id UUID,
  p_cap INTEGER DEFAULT 1
)
RETURNS TABLE(new_scans_remaining INTEGER) AS $$
  UPDATE merchants
  SET scans_remaining = LEAST(
        scans_remaining + 1,
        GREATEST(p_cap, scans_remaining)
      )
  WHERE id = p_merchant_id
    AND scans_remaining IS NOT NULL
  RETURNING scans_remaining AS new_scans_remaining;
$$ LANGUAGE sql;
