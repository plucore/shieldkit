/**
 * Phase 7 quick wins — pure-function unit tests.
 * Mirrors the math in api.cron.weekly-digest.ts (aiReadinessScore)
 * and lib/checks/public-scanner.server.ts (computeRiskScore).
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { computeRiskScore, RISK_WEIGHTS } from "../app/lib/checks/public-risk-score";

interface PublicCheckResult {
  check_name: string;
  passed: boolean;
  severity: "critical" | "warning" | "info" | "error";
  title: string;
  description: string;
  fix_instruction: string;
  raw_data: Record<string, unknown>;
}

function mkCheck(
  name: string,
  passed: boolean,
  severity: PublicCheckResult["severity"] = "info",
): PublicCheckResult {
  return {
    check_name: name,
    passed,
    severity,
    title: name,
    description: "",
    fix_instruction: "",
    raw_data: {},
  };
}

const ALL_NAMES = [
  "contact_information",
  "shipping_policy",
  "refund_return_policy",
  "privacy_and_terms",
  "structured_data_json_ld",
  "storefront_accessibility",
  "checkout_transparency",
  "page_speed",
];

// Pure mirror of the score formula in api.cron.weekly-digest.ts.
// schema 60% + llms.txt freshness 30% + bot config completeness 10%.
function aiReadinessScore(
  schemaShare: number,
  llmsFreshShare: number,
  botConfigShare: number,
): number {
  return Math.round(schemaShare * 60 + llmsFreshShare * 30 + botConfigShare * 10);
}

function botConfigShareFromPrefs(
  prefs: Record<string, unknown> | null | undefined,
): number {
  if (!prefs) return 0;
  return Object.values(prefs).filter((v) => v === true).length / 11;
}

describe("Phase 7 quick win 1 — aiReadinessScore", () => {
  it("returns 100 when all three inputs are 1", () => {
    expect(aiReadinessScore(1, 1, 1)).toBe(100);
  });

  it("returns 0 when all three inputs are 0", () => {
    expect(aiReadinessScore(0, 0, 0)).toBe(0);
  });

  it("returns 60 when only schema is full", () => {
    expect(aiReadinessScore(1, 0, 0)).toBe(60);
  });

  it("returns 30 when only llms freshness is set", () => {
    expect(aiReadinessScore(0, 1, 0)).toBe(30);
  });

  it("returns 10 when only bot config is full", () => {
    expect(aiReadinessScore(0, 0, 1)).toBe(10);
  });

  it("computes botConfigShare = 5/11 when 5 of 11 bots are true", () => {
    const prefs = {
      a: true, b: true, c: true, d: true, e: true,
      f: false, g: false, h: false, i: false, j: false, k: false,
    };
    expect(botConfigShareFromPrefs(prefs)).toBeCloseTo(5 / 11, 10);
  });

  it("returns 0 botConfigShare for null/missing preferences", () => {
    expect(botConfigShareFromPrefs(null)).toBe(0);
    expect(botConfigShareFromPrefs(undefined)).toBe(0);
    expect(botConfigShareFromPrefs({})).toBe(0);
  });

  it("api.cron.weekly-digest is removed in v4 (digest dropped)", () => {
    // v4 §4 deleted the weekly-digest cron and the lib/emails/weekly-digest
    // renderer. The aiReadinessScore math above is kept in this test file
    // as a pure function reference; it no longer ships in production code.
    expect(
      existsSync(
        join(__dirname, "..", "app", "routes", "api.cron.weekly-digest.ts"),
      ),
    ).toBe(false);
    expect(
      existsSync(
        join(__dirname, "..", "app", "lib", "emails", "weekly-digest.ts"),
      ),
    ).toBe(false);
  });

  it("scan.tsx renders RiskScoreBanner above the findings list", () => {
    const src = readFileSync(
      join(__dirname, "..", "app", "routes", "scan.tsx"),
      "utf8",
    );
    const bannerIdx = src.indexOf("<RiskScoreBanner");
    const findingsIdx = src.indexOf("Findings (");
    expect(bannerIdx).toBeGreaterThan(0);
    expect(findingsIdx).toBeGreaterThan(0);
    expect(bannerIdx).toBeLessThan(findingsIdx);
  });

  it("api.proxy.llms-txt records llms_txt_last_served_at", () => {
    const src = readFileSync(
      join(__dirname, "..", "app", "routes", "api.proxy.llms-txt.ts"),
      "utf8",
    );
    expect(src).toContain("llms_txt_last_served_at");
    expect(src).toContain("recordLlmsTxtServe");
  });
});

describe("Phase 7 quick win 2 — computeRiskScore", () => {
  const wt = (name: string): number => RISK_WEIGHTS[name] ?? 0;
  const TOTAL = Object.values(RISK_WEIGHTS).reduce((a, b) => a + b, 0);
  const norm = (w: number) => Math.round((w / TOTAL) * 100);
  const only = (name: string) =>
    computeRiskScore(ALL_NAMES.map((n) => mkCheck(n, n === name)));

  it("returns exactly 100 when every failable check passes (normalized)", () => {
    // Weights sum to <100 (checkout_transparency is unweighted), so the score
    // is normalized — a fully-passing store scores exactly 100.
    const checks = ALL_NAMES.map((n) => mkCheck(n, true));
    expect(computeRiskScore(checks)).toBe(100);
  });

  it("gives a store zero risk credit for the always-pass checkout check", () => {
    // Everything fails except checkout_transparency (which structurally passes).
    const checks = ALL_NAMES.map((n) =>
      mkCheck(n, n === "checkout_transparency", "info"),
    );
    expect(computeRiskScore(checks)).toBe(0);
  });

  it("returns 0 when all checks fail", () => {
    const checks = ALL_NAMES.map((n) => mkCheck(n, false, "critical"));
    expect(computeRiskScore(checks)).toBe(0);
  });

  it("contact_information contributes its normalized weight", () => {
    expect(only("contact_information")).toBe(norm(wt("contact_information")));
  });

  it("page_speed contributes its normalized weight", () => {
    expect(only("page_speed")).toBe(norm(wt("page_speed")));
  });

  it("preserves relative ordering of check contributions after normalization", () => {
    // contact (15) > storefront (10) > page_speed (5) — proportions intact.
    expect(only("contact_information")).toBeGreaterThan(only("storefront_accessibility"));
    expect(only("storefront_accessibility")).toBeGreaterThan(only("page_speed"));
  });

  it("ignores unknown check names", () => {
    const checks = [mkCheck("not_a_real_check", true)];
    expect(computeRiskScore(checks)).toBe(0);
  });

  it("computes mixed pass/fail correctly (3 policies pass, all else fail)", () => {
    const passing = new Set([
      "shipping_policy",
      "refund_return_policy",
      "privacy_and_terms",
    ]);
    const checks = ALL_NAMES.map((n) => mkCheck(n, passing.has(n)));
    const expected = norm(
      wt("shipping_policy") + wt("refund_return_policy") + wt("privacy_and_terms"),
    );
    expect(computeRiskScore(checks)).toBe(expected);
  });

  it("excludes an unmeasured (scorable:false) page_speed from numerator and denominator", () => {
    // Everything measurable passes; page_speed timed out (scorable:false). Its
    // weight is dropped from BOTH sides, so a fully-passing store still scores 100.
    const allPassPageSpeedUnmeasured = ALL_NAMES.map((n) =>
      n === "page_speed"
        ? { ...mkCheck(n, true), scorable: false }
        : mkCheck(n, true),
    );
    expect(computeRiskScore(allPassPageSpeedUnmeasured)).toBe(100);

    // A scorable:false page_speed is neither a free pass nor a penalty: dropping
    // its weight changes the denominator from 90 to 85, so a store that also
    // fails contact_information (15) scores 70/85 (82), not the old free-pass
    // 75/90 (83).
    const failContact = ALL_NAMES.map((n) => {
      if (n === "page_speed") return { ...mkCheck(n, true), scorable: false };
      if (n === "contact_information") return mkCheck(n, false, "warning");
      return mkCheck(n, true);
    });
    expect(computeRiskScore(failContact)).toBe(Math.round((70 / 85) * 100));
  });
});
