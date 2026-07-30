/**
 * tests/generated-policies-lost-update.test.ts
 *
 * Two concurrent generations of DIFFERENT policy types must both survive.
 *
 * THE BUG. The generatePolicy action read the whole generated_policies JSONB at
 * the top, spread it in memory —
 *
 *     const updatedPolicies = { ...generatedPolicies, [policyType]: policy.body };
 *
 * — and wrote the WHOLE object back. Two requests for different types both
 * start from the same base, so the second write drops the first's policy. Same
 * family as the scan-quota refund: an absolute write computed from a stale read.
 *
 * useSingleFlight does not cover it. That guard is per-button, and "generate
 * refund" and "generate shipping" are different buttons — nothing serialises
 * them.
 *
 * The first describe models both strategies against a shared row and shows the
 * old one losing data and the new one not. That is the whole invariant; the
 * rest pins the route and the migration to it.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");

type Row = { generated_policies: Record<string, string>; policy_regen_used: Record<string, boolean> };

/** What the route used to do: whole-object write from a pre-read snapshot. */
function wholeObjectWrite(row: Row, snapshot: Record<string, string>, type: string, body: string) {
  row.generated_policies = { ...snapshot, [type]: body };
}

/** What set_generated_policy does: jsonb_set of one key against the CURRENT row. */
function singleKeyWrite(
  row: Row,
  type: string,
  body: string,
  markRegenUsed = false,
) {
  row.generated_policies = { ...row.generated_policies, [type]: body };
  if (markRegenUsed) {
    row.policy_regen_used = { ...row.policy_regen_used, [type]: true };
  }
}

describe("concurrent generations of different policy types", () => {
  it("the OLD whole-object write loses one — this is the bug", () => {
    const row: Row = { generated_policies: {}, policy_regen_used: {} };

    // Both requests load the row at the same time: both see {}.
    const snapshotA = { ...row.generated_policies };
    const snapshotB = { ...row.generated_policies };

    // A finishes generating first, then B.
    wholeObjectWrite(row, snapshotA, "refund", "REFUND BODY");
    wholeObjectWrite(row, snapshotB, "shipping", "SHIPPING BODY");

    // B's write was built from a snapshot taken before A existed.
    expect(row.generated_policies).toEqual({ shipping: "SHIPPING BODY" });
    expect(row.generated_policies.refund).toBeUndefined(); // silently lost
  });

  it("the NEW single-key write keeps both, in either completion order", () => {
    for (const order of [
      ["refund", "shipping"],
      ["shipping", "refund"],
    ] as const) {
      const row: Row = { generated_policies: {}, policy_regen_used: {} };
      // Snapshots are irrelevant now — each write targets the current row.
      singleKeyWrite(row, order[0], `${order[0].toUpperCase()} BODY`);
      singleKeyWrite(row, order[1], `${order[1].toUpperCase()} BODY`);

      expect(row.generated_policies).toEqual({
        refund: "REFUND BODY",
        shipping: "SHIPPING BODY",
      });
    }
  });

  it("a regen of one type does not disturb another type's policy or regen flag", () => {
    const row: Row = {
      generated_policies: { refund: "OLD REFUND", terms: "TERMS" },
      policy_regen_used: { terms: true },
    };
    singleKeyWrite(row, "refund", "NEW REFUND", true);

    expect(row.generated_policies).toEqual({
      refund: "NEW REFUND",
      terms: "TERMS", // untouched
    });
    expect(row.policy_regen_used).toEqual({ terms: true, refund: true });
  });
});

describe("the route persists via the RPC, never a whole-object write", () => {
  const route = readFileSync(join(ROOT, "app/routes/app._index.tsx"), "utf-8");

  it("both persist paths call set_generated_policy", () => {
    expect(route).toContain('rpc("set_generated_policy"');
    // First generation AND the degraded regen fallback.
    expect((route.match(/rpc\("set_generated_policy"/g) ?? []).length).toBe(2);
    expect(route).toContain("p_mark_regen_used: true");
  });

  it("no longer writes generated_policies or policy_regen_used as whole columns", () => {
    // The exact defect shape. Its return is the bug's return.
    expect(route).not.toMatch(/\.update\(\{\s*generated_policies:/);
    expect(route).not.toMatch(/generated_policies:\s*updatedPolicies\b[\s\S]{0,80}\.eq\("id"/);
    expect(route).not.toMatch(/policy_regen_used:\s*\{\s*\.\.\.regenUsed/);
  });

  it("still keeps finalize_policy_regen as the concurrent-regen arbiter", () => {
    // set_generated_policy is unconditional; it cannot decide who wins a race.
    // Dropping finalize_policy_regen would let two regens both succeed.
    expect(route).toContain("finalize_policy_regen");
    expect(route).toContain("regen_exhausted");
  });
});

describe("migration shape", () => {
  const migration = readFileSync(
    join(ROOT, "supabase/migrations/20260730160000_set_generated_policy.sql"),
    "utf-8",
  );

  it("uses jsonb_set on both columns in a single statement", () => {
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION set_generated_policy/);
    expect((migration.match(/jsonb_set\(/g) ?? []).length).toBe(2);
    // COALESCE so a NULL column doesn't make jsonb_set a no-op.
    expect(migration).toMatch(/COALESCE\(generated_policies/);
    expect(migration).toMatch(/COALESCE\(policy_regen_used/);
    // create_missing = true, or a first generation would never be written.
    expect(migration).toMatch(/to_jsonb\(p_body\),\s*\n?\s*true/);
  });

  it("is mirrored into schema.sql for bootstrap parity", () => {
    const schema = readFileSync(join(ROOT, "supabase/schema.sql"), "utf-8");
    expect(schema).toContain("CREATE OR REPLACE FUNCTION set_generated_policy");
  });
});
