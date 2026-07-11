/**
 * Behavioral tests for page_speed graceful degradation.
 *
 * Production logs showed `[Scanner] PageSpeed check failed: The operation was
 * aborted due to timeout` on otherwise-healthy scans — Google's external
 * PageSpeed API being slow, not a store problem. These lock in that an
 * unmeasurable PageSpeed response degrades to a calm, non-scorable INFO
 * ("not measured") that never moves the compliance score, while a genuinely
 * poor *measured* score still produces the normal warning.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { checkPageSpeed } from "../app/lib/checks/page-speed.server";
import { computeComplianceScore } from "../app/lib/checks/compliance-score";
import type { CheckResult, Severity } from "../app/lib/checks/types";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function psiResponse(score: number | null, audits: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      lighthouseResult: {
        categories: { performance: score === null ? {} : { score } },
        audits,
      },
    }),
  } as unknown as Response;
}

function mkResult(over: Partial<CheckResult>): CheckResult {
  return {
    check_name: "x",
    passed: true,
    severity: "warning",
    title: "t",
    description: "d",
    fix_instruction: "f",
    raw_data: {},
    ...over,
  };
}

describe("checkPageSpeed degrades gracefully when PageSpeed is unmeasurable", () => {
  it("timeout / abort / network error → non-scorable INFO 'not measured'", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("The operation was aborted due to timeout"), {
          name: "TimeoutError",
        }),
      ) as unknown as typeof fetch;

    const r = await checkPageSpeed("https://store.example");

    expect(r.check_name).toBe("page_speed");
    expect(r.severity).toBe("info"); // NOT "error", NOT "warning"
    expect(r.passed).toBe(true); // NOT a failure
    expect(r.scorable).toBe(false); // excluded from the score denominator
    expect(r.description).toContain("This doesn't affect your compliance status");
    // Must not read as a store problem.
    expect(r.description.toLowerCase()).not.toContain("failed");
  });

  it("non-200 (e.g. 429 rate-limit) → non-scorable INFO", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 429 } as Response) as unknown as typeof fetch;

    const r = await checkPageSpeed("https://store.example");

    expect(r.severity).toBe("info");
    expect(r.passed).toBe(true);
    expect(r.scorable).toBe(false);
    expect(r.raw_data.api_status).toBe(429);
  });

  it("successful response with no score → non-scorable INFO", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(psiResponse(null)) as unknown as typeof fetch;

    const r = await checkPageSpeed("https://store.example");

    expect(r.severity).toBe("info");
    expect(r.passed).toBe(true);
    expect(r.scorable).toBe(false);
  });

  it("successful poor-score response → INFO finding (not WARNING), still scored", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(psiResponse(0.2)) as unknown as typeof fetch; // 20/100

    const r = await checkPageSpeed("https://store.example");

    // Page speed isn't a GMC suspension criterion → INFO, not WARNING.
    expect(r.severity).toBe("info");
    expect(r.passed).toBe(false);
    expect(r.scorable).not.toBe(false); // measured → participates in scoring
    expect(r.description).toContain("20/100");
  });

  it("successful good-score response → passing, measured result", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(psiResponse(0.95)) as unknown as typeof fetch; // 95/100

    const r = await checkPageSpeed("https://store.example");

    expect(r.passed).toBe(true);
    expect(r.scorable).not.toBe(false);
    expect(r.raw_data.measured).toBe(true);
  });
});

describe("computeComplianceScore excludes non-scorable / errored checks", () => {
  const pass = (severity: Severity = "warning") =>
    mkResult({ passed: true, severity });
  const fail = (severity: Severity = "critical") =>
    mkResult({ passed: false, severity });

  it("a timed-out page_speed (scorable:false) does not move the score", () => {
    // 8 pass + 2 fail = 80. Adding a skipped check keeps it at 80.
    const base = [
      ...Array.from({ length: 8 }, () => pass()),
      fail(),
      fail(),
    ];
    const skipped = mkResult({ passed: true, severity: "info", scorable: false });

    expect(computeComplianceScore(base).complianceScore).toBe(80);
    expect(computeComplianceScore([...base, skipped]).complianceScore).toBe(80);
    // The skipped check is out of both numerator and denominator.
    expect(computeComplianceScore([...base, skipped]).scorableTotal).toBe(10);
  });

  it("errored checks stay excluded (existing behavior preserved)", () => {
    const results = [pass(), pass(), fail(), mkResult({ passed: false, severity: "error" })];
    // 3 scorable: 2 pass / 3 = 66.67
    expect(computeComplianceScore(results).complianceScore).toBeCloseTo(66.67, 2);
  });

  it("a passed INFO check that is still scorable counts normally", () => {
    const results = [pass(), mkResult({ passed: true, severity: "info" })];
    expect(computeComplianceScore(results).complianceScore).toBe(100);
    expect(computeComplianceScore(results).scorableTotal).toBe(2);
  });

  it("all-non-scorable yields 0 (no divide-by-zero)", () => {
    const results = [mkResult({ passed: true, severity: "info", scorable: false })];
    expect(computeComplianceScore(results).complianceScore).toBe(0);
    expect(computeComplianceScore(results).scorableTotal).toBe(0);
  });
});
