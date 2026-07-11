/**
 * app/lib/checks/public-risk-score.ts
 *
 * Phase 7 quick win 2 — pure, isomorphic risk-score helper for the
 * public /scan page. Lives outside the .server module so the React
 * component can import it without dragging server-only deps (cheerio,
 * node:dns, etc.) into the client bundle.
 *
 * Higher = lower risk. The raw weights below sum to less than 100 (an
 * always-pass check was removed — see below), so computeRiskScore normalizes
 * the earned weight against the total available weight: a fully-passing store
 * scores exactly 100 and each check keeps its RELATIVE proportion. See note in
 * public-scanner.server.ts for the mapping rationale (some original-spec check
 * IDs aren't computable from the public Admin-API-less scanner, so their weight
 * is redistributed across what we can measure).
 *
 * checkout_transparency is intentionally NOT weighted: it is an INFO-only
 * best-practice check that can never fail, so awarding it weight added a fixed,
 * non-discriminating floor to the risk score. It is removed rather than
 * re-tuned into the other weights; proportional normalization (not per-check
 * hand-tuning) restores the 0–100 range without changing relative ordering.
 */

export interface RiskScoreCheck {
  check_name: string;
  passed: boolean;
  /**
   * false = the check ran but couldn't obtain a real signal (e.g. page_speed
   * when Google's PageSpeed API times out). Excluded from BOTH the numerator
   * and the denominator so a transient external failure never moves the score —
   * mirrors isScorable() in the authenticated compliance-score.ts.
   */
  scorable?: boolean;
}

export const RISK_WEIGHTS: Record<string, number> = {
  contact_information: 15,
  shipping_policy: 15,
  refund_return_policy: 15,
  privacy_and_terms: 15,
  structured_data_json_ld: 15,
  storefront_accessibility: 10,
  page_speed: 5,
};

/** Total available weight — a fully-passing store earns exactly this. */
const TOTAL_WEIGHT = Object.values(RISK_WEIGHTS).reduce((sum, w) => sum + w, 0);

export function computeRiskScore(checks: RiskScoreCheck[]): number {
  let earned = 0;
  let excludedWeight = 0;
  for (const check of checks) {
    const weight = RISK_WEIGHTS[check.check_name];
    if (weight === undefined) continue;
    if (check.scorable === false) {
      // Unmeasured (e.g. PageSpeed API timeout) — drop its weight from the
      // available denominator so it is neither a free pass nor a penalty.
      excludedWeight += weight;
      continue;
    }
    if (check.passed) earned += weight;
  }
  // Normalize against the AVAILABLE weight (total minus any unmeasured checks)
  // so a fully-passing store scores exactly 100 (the raw weights sum to <100)
  // while preserving each check's relative contribution.
  const availableWeight = TOTAL_WEIGHT - excludedWeight;
  const score = availableWeight > 0 ? (earned / availableWeight) * 100 : 0;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Simple pass-ratio headline score for the public /scan page (`result.score`).
 * Distinct from computeRiskScore (which is weighted), but it applies the SAME
 * exclusion rule: errored AND unmeasured (scorable:false, e.g. a PageSpeed API
 * timeout) checks are dropped from BOTH the numerator and the denominator — as
 * in the authenticated scanner — so a transient external failure never moves it
 * and the two scores shown on /scan stay consistent.
 */
export function computeHeadlineScore(
  results: ReadonlyArray<{ passed: boolean; severity: string; scorable?: boolean }>,
): number {
  const scorable = results.filter(
    (r) => r.severity !== "error" && r.scorable !== false,
  );
  if (scorable.length === 0) return 0;
  const passed = scorable.filter((r) => r.passed).length;
  return Math.round((passed / scorable.length) * 100);
}
