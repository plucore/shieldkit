-- ============================================================
-- set_generated_policy — write ONE policy key, not the whole object
--
-- THE BUG. app/routes/app._index.tsx read the entire generated_policies JSONB
-- at the top of the action, spread it in memory,
--
--     const updatedPolicies = { ...generatedPolicies, [policyType]: policy.body };
--
-- and wrote the WHOLE object back. Two concurrent generations of DIFFERENT
-- policy types both start from the same base, so the second write silently
-- drops the first merchant's policy. A lost update of exactly the kind the
-- scan-quota refund was (an absolute write computed from a stale read) — same
-- family, different column.
--
-- The per-button useSingleFlight guard does not help: these are different
-- buttons, so nothing serialises "generate refund" against "generate shipping".
--
-- THE FIX. jsonb_set writes a single key against the CURRENT row inside one
-- statement, so a concurrent write to a different key cannot be clobbered and
-- the read-modify-write disappears entirely.
--
-- p_mark_regen_used folds in the non-atomic degraded path that used to sit in
-- the route: when finalize_policy_regen is unavailable, the route previously
-- wrote generated_policies AND policy_regen_used from two stale in-memory
-- objects. Both keys are now set in the SAME statement, each with jsonb_set, so
-- the fallback stops being a second lost-update site.
--
-- NOTE ON SCOPE. This does NOT replace finalize_policy_regen. That function
-- carries the conditional guard that decides WHO WINS a concurrent regen (it
-- returns zero rows to the loser so its output is discarded). This one is the
-- unconditional single-key writer used for a first generation, and — with
-- p_mark_regen_used — for the degraded fallback. Keep both.
--
-- `true` is returned when a row matched, so the caller can distinguish "wrote"
-- from "no such merchant" instead of assuming success.
-- ============================================================
CREATE OR REPLACE FUNCTION set_generated_policy(
  p_merchant_id UUID,
  p_type TEXT,
  p_body TEXT,
  p_mark_regen_used BOOLEAN DEFAULT false
)
RETURNS TABLE(written BOOLEAN) AS $$
  UPDATE merchants
  SET generated_policies = jsonb_set(
        COALESCE(generated_policies, '{}'::jsonb),
        ARRAY[p_type],
        to_jsonb(p_body),
        true
      ),
      policy_regen_used = CASE
        WHEN p_mark_regen_used THEN jsonb_set(
          COALESCE(policy_regen_used, '{}'::jsonb),
          ARRAY[p_type],
          'true'::jsonb,
          true
        )
        ELSE COALESCE(policy_regen_used, '{}'::jsonb)
      END
  WHERE id = p_merchant_id
  RETURNING true AS written;
$$ LANGUAGE sql;
