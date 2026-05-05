/**
 * Phase 7 quick wins — pure-function unit tests.
 * Mirrors the math in api.cron.weekly-digest.ts (aiReadinessScore)
 * and lib/checks/public-scanner.server.ts (computeRiskScore).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeRiskScore } from "../app/lib/checks/public-risk-score";

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

  it("api.cron.weekly-digest references real freshness sources (no hardcoded zeros)", () => {
    const src = readFileSync(
      join(__dirname, "..", "app", "routes", "api.cron.weekly-digest.ts"),
      "utf8",
    );
    expect(src).toContain("llms_txt_last_served_at");
    expect(src).toContain("bot_preferences");
    expect(src).not.toMatch(/llmsFreshShare\s*=\s*0;/);
    expect(src).not.toMatch(/botConfigShare\s*=\s*0;/);
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
  it("returns 100 when all 8 checks pass", () => {
    const checks = ALL_NAMES.map((n) => mkCheck(n, true));
    expect(computeRiskScore(checks)).toBe(100);
  });

  it("returns 0 when all 8 checks fail", () => {
    const checks = ALL_NAMES.map((n) => mkCheck(n, false, "critical"));
    expect(computeRiskScore(checks)).toBe(0);
  });

  it("weights contact_information at 15", () => {
    const checks = ALL_NAMES.map((n) =>
      mkCheck(n, n === "contact_information"),
    );
    expect(computeRiskScore(checks)).toBe(15);
  });

  it("weights page_speed at 5", () => {
    const checks = ALL_NAMES.map((n) => mkCheck(n, n === "page_speed"));
    expect(computeRiskScore(checks)).toBe(5);
  });

  it("ignores unknown check names", () => {
    const checks = [mkCheck("not_a_real_check", true)];
    expect(computeRiskScore(checks)).toBe(0);
  });

  it("computes mixed pass/fail correctly (3 policies pass, all else fail = 45)", () => {
    const passing = new Set([
      "shipping_policy",
      "refund_return_policy",
      "privacy_and_terms",
    ]);
    const checks = ALL_NAMES.map((n) => mkCheck(n, passing.has(n)));
    expect(computeRiskScore(checks)).toBe(45);
  });
});
