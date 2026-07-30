/**
 * tests/violations-scorable.test.ts
 *
 * The stored violations row must say whether it counted toward the score.
 *
 * `scorable` was a transient in-memory hint, so an unmeasurable check landed in
 * the DB byte-identical to a genuine pass (passed=true, severity='info'). The
 * score was always right — 81.82 is 9/11, not 10/12 — but nothing in SQL could
 * show WHICH row was excluded, and on 2026-07-29 that produced a false positive
 * in an audit of this database: page_speed read as a check that can never fail
 * and inflates every score by ~8 points. It does neither.
 *
 * The invariant: count(*) FILTER (WHERE scorable) per scan == the score's
 * denominator, derived from the SAME predicate the score uses.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isScorable, computeComplianceScore } from "../app/lib/checks/compliance-score";
import type { CheckResult } from "../app/lib/checks/types";

const ROOT = join(__dirname, "..");

function res(over: Partial<CheckResult>): CheckResult {
  return {
    check_name: "x",
    passed: true,
    severity: "info",
    title: "t",
    description: "d",
    fix_instruction: "f",
    raw_data: {},
    ...over,
  } as CheckResult;
}

describe("persisted scorable reproduces the score denominator", () => {
  it("the flag equals isScorable for every result class", () => {
    // A measured pass counts; an errored check and an unmeasurable one do not.
    expect(isScorable(res({ severity: "warning" }))).toBe(true);
    expect(isScorable(res({ severity: "error" }))).toBe(false);
    expect(isScorable(res({ scorable: false }))).toBe(false);
    // undefined means "counted" — the default for every ordinary check.
    expect(isScorable(res({ scorable: undefined }))).toBe(true);
  });

  it("counting the flag reproduces scorableTotal exactly (the 9/11 case)", () => {
    // The real shape of a scan where page_speed could not be measured: 12
    // checks, 10 with passed=true (one of them the unmeasurable page_speed),
    // 2 genuine failures.
    const results: CheckResult[] = [
      ...Array.from({ length: 9 }, (_, i) =>
        res({ check_name: `pass_${i}`, passed: true, severity: "warning" }),
      ),
      res({ check_name: "page_speed", passed: true, severity: "info", scorable: false }),
      res({ check_name: "fail_a", passed: false, severity: "critical" }),
      res({ check_name: "fail_b", passed: false, severity: "warning" }),
    ];

    const { complianceScore, scorableTotal, scorablePassed } =
      computeComplianceScore(results);

    // What the columns would say vs what the score actually is.
    expect(results).toHaveLength(12); // total_checks
    expect(results.filter((r) => r.passed)).toHaveLength(10); // passed_checks
    expect(scorableTotal).toBe(11);
    expect(scorablePassed).toBe(9);
    expect(complianceScore).toBe(81.82); // 9/11, NOT 10/12 = 83.33

    // The persisted flag is what makes that reconstructable in SQL.
    const persisted = results.map((r) => isScorable(r));
    expect(persisted.filter(Boolean)).toHaveLength(scorableTotal);
  });
});

describe("the writer persists the flag", () => {
  const src = readFileSync(join(ROOT, "app/lib/checks/index.server.ts"), "utf-8");

  it("writes isScorable(r) on every check row — one predicate, not a second rule", () => {
    expect(src).toContain("scorable: isScorable(r)");
    expect(src).toMatch(
      /import \{ computeComplianceScore, isScorable \} from "\.\/compliance-score"/,
    );
  });

  it("marks the synthetic scan_data_availability row non-scorable", () => {
    // It is not in checkResults and never reached computeComplianceScore, so
    // anything but false would break the count(*) FILTER identity.
    const idx = src.indexOf('check_name: "scan_data_availability"');
    expect(idx).toBeGreaterThan(0);
    expect(src.slice(idx, idx + 900)).toContain("scorable: false");
  });

  it("does NOT redefine total_checks or passed_checks", () => {
    // ScoreTrend computes issues-fixed as (total_checks - passed_checks), which
    // is correct precisely because a non-scorable check appears in both terms
    // and cancels. Changing either would silently alter every historical row.
    expect(src).toContain("const totalChecks = checkResults.length");
    expect(src).toContain("const passedChecks = checkResults.filter((r) => r.passed).length");
  });
});

describe("migration shape", () => {
  const migration = readFileSync(
    join(ROOT, "supabase/migrations/20260730140000_violations_scorable.sql"),
    "utf-8",
  );

  it("adds a nullable boolean with no backfill and no default", () => {
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS scorable BOOLEAN/);
    // NULL must stay "pre-migration, unknown" — defaulting or backfilling would
    // be guessing at history, which is the thing the column exists to prevent.
    expect(migration).not.toMatch(/DEFAULT\s+(true|false)/i);
    expect(migration).not.toMatch(/UPDATE\s+violations/i);
    expect(migration).not.toMatch(/NOT NULL/i);
  });
});
