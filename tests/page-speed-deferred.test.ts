/**
 * tests/page-speed-deferred.test.ts
 *
 * PageSpeed moved off the scan's invocation (2026-07-30).
 *
 * WHY. PSI runs a full Lighthouse audit on demand. Behind the scan's 30s abort
 * it failed on roughly two thirds of scans: 17 of 26 recorded attempts were
 * non-measurements and 16 of those 17 were timeouts. Zero were 429s and the API
 * key is set in production, so it was never quota or credentials.
 *
 * Cache-warming was considered and REFUTED by production data — sex-eshop timed
 * out twice 11 seconds apart, 7wf1na-x2 five times at 2-4 minute intervals.
 * Success tracks the STORE, not a warm cache.
 *
 * The invariant that makes the deferred patch safe: page_speed is PERMANENTLY
 * non-scorable, so the denominator is 11 whether or not PSI ever answers, and a
 * result arriving after the merchant saw their score cannot move it.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  pendingPageSpeed,
  measurePageSpeed,
  PAGE_SPEED_TRIGGER,
  PAGE_SPEED_CHECK_NAME,
} from "../app/lib/checks/page-speed.server";
import { computeComplianceScore, isScorable } from "../app/lib/checks/compliance-score";
import type { CheckResult } from "../app/lib/checks/types";

const ROOT = join(__dirname, "..");
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function psiResponse(score: number | null) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      lighthouseResult: { categories: { performance: score === null ? {} : { score } }, audits: {} },
    }),
  } as unknown as Response;
}

const other = (passed: boolean): CheckResult =>
  ({
    check_name: "x",
    passed,
    severity: passed ? "warning" : "critical",
    title: "t",
    description: "d",
    fix_instruction: "f",
    raw_data: {},
  }) as CheckResult;

describe("the scan writes a pending row and makes no network call", () => {
  it("pendingPageSpeed is synchronous and non-scorable", () => {
    // If this ever touches the network the whole point is lost.
    globalThis.fetch = vi.fn(() => {
      throw new Error("pendingPageSpeed must not call fetch");
    }) as unknown as typeof fetch;

    const r = pendingPageSpeed("https://store.example");
    expect(r.check_name).toBe(PAGE_SPEED_CHECK_NAME);
    expect(r.scorable).toBe(false);
    expect(r.severity).toBe("info");
    expect(r.passed).toBe(true);
    expect(r.raw_data.pending).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("page_speed is permanently non-scorable, on EVERY path", () => {
  it("every outcome returns scorable:false", async () => {
    const outcomes: CheckResult[] = [pendingPageSpeed("https://s.example")];

    globalThis.fetch = vi.fn().mockResolvedValue(psiResponse(0.95)) as unknown as typeof fetch;
    outcomes.push(await measurePageSpeed("https://s.example")); // fast

    globalThis.fetch = vi.fn().mockResolvedValue(psiResponse(0.2)) as unknown as typeof fetch;
    outcomes.push(await measurePageSpeed("https://s.example")); // slow

    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 429 } as Response) as unknown as typeof fetch;
    outcomes.push(await measurePageSpeed("https://s.example")); // rate limited

    globalThis.fetch = vi.fn().mockRejectedValue(new Error("timeout")) as unknown as typeof fetch;
    outcomes.push(await measurePageSpeed("https://s.example")); // timeout

    for (const r of outcomes) {
      expect(r.scorable).toBe(false);
      expect(isScorable(r)).toBe(false);
    }
  });

  it("patching pending -> measured cannot move the score (the whole safety argument)", async () => {
    const eleven = [
      ...Array.from({ length: 9 }, () => other(true)),
      other(false),
      other(false),
    ];

    const before = computeComplianceScore([...eleven, pendingPageSpeed("https://s.example")]);

    globalThis.fetch = vi.fn().mockResolvedValue(psiResponse(0.2)) as unknown as typeof fetch;
    const measured = await measurePageSpeed("https://s.example");
    const after = computeComplianceScore([...eleven, measured]);

    // Denominator pinned at 11 in both states, and the score is identical even
    // though the check went from "pending/passed" to "slow/failed".
    expect(before.scorableTotal).toBe(11);
    expect(after.scorableTotal).toBe(11);
    expect(after.complianceScore).toBe(before.complianceScore);
  });
});

describe("elapsed_ms is recorded on every outcome", () => {
  it("records timing on success AND on failure", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(psiResponse(0.8)) as unknown as typeof fetch;
    const okRes = await measurePageSpeed("https://s.example");
    expect(typeof okRes.raw_data.elapsed_ms).toBe("number");

    globalThis.fetch = vi.fn().mockRejectedValue(new Error("boom")) as unknown as typeof fetch;
    const failRes = await measurePageSpeed("https://s.example");
    // Without timing on the FAILURE path there is no way to tell "budget too
    // small" from "PSI is down" — the question the 30s inline version could
    // never answer.
    expect(typeof failRes.raw_data.elapsed_ms).toBe("number");
  });
});

describe("the queue wiring", () => {
  it("the scan enqueues a page_speed trigger after the violations insert", () => {
    const src = readFileSync(join(ROOT, "app/lib/checks/index.server.ts"), "utf-8");
    expect(src).toContain("PAGE_SPEED_TRIGGER");
    expect(src).toContain("pendingPageSpeed");
    // Must come after the violations insert or the cron patches a row that
    // does not exist yet.
    const insertIdx = src.indexOf('.from("violations")');
    const enqueueIdx = src.indexOf('.from("pending_scan_triggers")');
    expect(insertIdx).toBeGreaterThan(0);
    expect(enqueueIdx).toBeGreaterThan(insertIdx);
  });

  it("the enrichment drainer does NOT sweep page_speed rows", () => {
    // The legacy branch marks rows processed without doing any work. Without
    // this exclusion a paid merchant's queued measurement is silently
    // discarded and the row stays "checking in the background" forever.
    const src = readFileSync(
      join(ROOT, "app/routes/api.cron.process-scan-triggers.ts"),
      "utf-8",
    );
    expect(src).toMatch(/legacyRows[\s\S]{0,300}!==\s*PAGE_SPEED_TRIGGER/);
  });

  it("the cron patches the row and never touches compliance_score", () => {
    const src = readFileSync(
      join(ROOT, "app/routes/api.cron.measure-page-speed.ts"),
      "utf-8",
    );
    expect(src).toContain('.from("violations")');
    expect(src).toContain("scorable: false");
    // The score is the one thing that must never move after the fact.
    expect(src).not.toMatch(/compliance_score:/);
    expect(src).not.toMatch(/total_checks:/);
    // Raw tallies DO move (they count all 12 including non-scorable), so they
    // are recomputed rather than left stale.
    expect(src).toContain("passed_checks:");
    // A malformed payload must advance, or it wedges the queue head.
    expect(src).toMatch(/!scanId \|\| !storeUrl[\s\S]{0,200}markProcessed/);
  });

  it("is scheduled, and reachable by both GET and POST", () => {
    const src = readFileSync(
      join(ROOT, "app/routes/api.cron.measure-page-speed.ts"),
      "utf-8",
    );
    // Vercel Cron issues GET; GitHub Actions POSTs. Authorisation is the bearer
    // token inside run(), never the verb (claude.md §7).
    expect(src).toContain("export async function loader");
    expect(src).toContain("export async function action");

    const vercel = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf-8"));
    const paths = (vercel.crons ?? []).map((c: { path: string }) => c.path);
    expect(paths).toContain("/api/cron/measure-page-speed");

    const wf = readFileSync(
      join(ROOT, ".github/workflows/measure-page-speed.yml"),
      "utf-8",
    );
    expect(wf).toContain("/api/cron/measure-page-speed");
    expect(wf).toContain("--request POST");
  });
});

describe("PAGE_SPEED_TRIGGER is the single source for the trigger name", () => {
  it("is not re-typed as a literal in either consumer", () => {
    expect(PAGE_SPEED_TRIGGER).toBe("page_speed");
    for (const rel of [
      "app/lib/checks/index.server.ts",
      "app/routes/api.cron.process-scan-triggers.ts",
      "app/routes/api.cron.measure-page-speed.ts",
    ]) {
      const src = readFileSync(join(ROOT, rel), "utf-8");
      expect(src).toContain("PAGE_SPEED_TRIGGER");
    }
  });
});
