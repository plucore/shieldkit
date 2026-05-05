/**
 * app/lib/checks/public-risk-score.ts
 *
 * Phase 7 quick win 2 — pure, isomorphic risk-score helper for the
 * public /scan page. Lives outside the .server module so the React
 * component can import it without dragging server-only deps (cheerio,
 * node:dns, etc.) into the client bundle.
 *
 * Higher = lower risk. Weights sum to 100 across the 8 checks the
 * public scanner emits. See note in public-scanner.server.ts for the
 * mapping rationale (some original-spec check IDs aren't computable
 * from the public Admin-API-less scanner, so their weight is
 * redistributed across what we can measure).
 */

export interface RiskScoreCheck {
  check_name: string;
  passed: boolean;
}

export const RISK_WEIGHTS: Record<string, number> = {
  contact_information: 15,
  shipping_policy: 15,
  refund_return_policy: 15,
  privacy_and_terms: 15,
  structured_data_json_ld: 15,
  storefront_accessibility: 10,
  checkout_transparency: 10,
  page_speed: 5,
};

export function computeRiskScore(checks: RiskScoreCheck[]): number {
  let total = 0;
  for (const check of checks) {
    const weight = RISK_WEIGHTS[check.check_name];
    if (weight === undefined) continue;
    if (check.passed) total += weight;
  }
  return Math.max(0, Math.min(100, Math.round(total)));
}
