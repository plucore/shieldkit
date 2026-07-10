/**
 * app/lib/checks/compliance-score.ts
 *
 * Pure, isomorphic compliance-score helper for the authenticated 12-point scan.
 * Kept out of the .server orchestrator (mirrors public-risk-score.ts) so the
 * scoring rule is unit-testable without spinning up Supabase / Shopify mocks.
 *
 * Scoring rule: a check counts toward the score ONLY when it was actually
 * measured. Two classes of check are excluded from BOTH the numerator and the
 * denominator so a transient failure never moves the merchant's score:
 *   1. severity "error"      — the check threw (safeCheck wrapper).
 *   2. scorable === false    — the check ran but couldn't obtain a real signal,
 *                              e.g. page_speed when Google's external PageSpeed
 *                              API times out. Excluding it (rather than scoring
 *                              it as a pass or a fail) means an unmeasurable
 *                              external dependency is neutral, never a store
 *                              problem and never a free point.
 */

import type { CheckResult } from "./types";

/** A check participates in the compliance score only when it was measured. */
export function isScorable(
  r: Pick<CheckResult, "severity" | "scorable">,
): boolean {
  return r.severity !== "error" && r.scorable !== false;
}

export interface ComplianceScoreResult {
  /** 0–100, rounded to two decimals. 0 when nothing was scorable. */
  complianceScore: number;
  /** Number of scorable checks that passed (score numerator). */
  scorablePassed: number;
  /** Number of scorable checks (score denominator). */
  scorableTotal: number;
}

export function computeComplianceScore(
  results: ReadonlyArray<Pick<CheckResult, "passed" | "severity" | "scorable">>,
): ComplianceScoreResult {
  const scorable = results.filter(isScorable);
  const scorablePassed = scorable.filter((r) => r.passed).length;
  const scorableTotal = scorable.length;
  const complianceScore =
    scorableTotal > 0
      ? Math.round((scorablePassed / scorableTotal) * 10_000) / 100
      : 0;
  return { complianceScore, scorablePassed, scorableTotal };
}
