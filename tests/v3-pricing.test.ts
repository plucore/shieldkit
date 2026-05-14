/**
 * tests/v3-pricing.test.ts
 *
 * v3 pricing model (Monitoring + Recovery + grandfathered Shield Pro/Max)
 * shape, helper, and gate-site assertions.
 *
 *  - Helpers `hasMonitoringAccess` / `hasRecoveryAccess` enforce the access
 *    matrix as documented in plans.ts.
 *  - PLAN_NAME_TO_TIER / PLAN_NAME_TO_CYCLE include both the v3 plans AND
 *    the grandfathered Shield Pro / Shield Max plan strings, so the 2 live
 *    paying customers continue to reconcile correctly.
 *  - Every gate-site call uses the helpers (centralised) rather than raw
 *    `tier === "..."` comparisons.
 *
 * Direct import of the helpers — exercised against real values, not just
 * file-content matching — so a refactor that breaks the matrix fails loudly.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PLAN_NAME_TO_TIER,
  PLAN_NAME_TO_CYCLE,
  MONITORING_TIERS,
  hasMonitoringAccess,
  hasRecoveryAccess,
} from "../app/lib/billing/plans";

const root = join(__dirname, "..");
const read = (...parts: string[]) =>
  readFileSync(join(root, ...parts), "utf8");

describe("v3 plan reference data", () => {
  it("PLAN_NAME_TO_TIER includes the three new plan-name strings", () => {
    expect(PLAN_NAME_TO_TIER["Monitoring"]).toBe("monitoring");
    expect(PLAN_NAME_TO_TIER["Monitoring Annual"]).toBe("monitoring");
    expect(PLAN_NAME_TO_TIER["Recovery"]).toBe("recovery");
  });

  it("PLAN_NAME_TO_TIER preserves grandfathered Shield Pro/Max entries", () => {
    // The 2 live paying customers on 2026-05-14 are on Shield Max under
    // tier='pro'. Removing these mappings would break webhook + Partner
    // API reconciliation for them. Do not delete.
    expect(PLAN_NAME_TO_TIER["Shield Pro"]).toBe("shield");
    expect(PLAN_NAME_TO_TIER["Shield Pro Annual"]).toBe("shield");
    expect(PLAN_NAME_TO_TIER["Shield Max"]).toBe("pro");
    expect(PLAN_NAME_TO_TIER["Shield Max Annual"]).toBe("pro");
  });

  it("PLAN_NAME_TO_CYCLE covers all v3 + grandfathered plans", () => {
    expect(PLAN_NAME_TO_CYCLE["Monitoring"]).toBe("monthly");
    expect(PLAN_NAME_TO_CYCLE["Monitoring Annual"]).toBe("annual");
    expect(PLAN_NAME_TO_CYCLE["Recovery"]).toBe("annual");
    expect(PLAN_NAME_TO_CYCLE["Shield Pro"]).toBe("monthly");
    expect(PLAN_NAME_TO_CYCLE["Shield Pro Annual"]).toBe("annual");
    expect(PLAN_NAME_TO_CYCLE["Shield Max"]).toBe("monthly");
    expect(PLAN_NAME_TO_CYCLE["Shield Max Annual"]).toBe("annual");
  });

  it("MONITORING_TIERS lists the DB tier values that get the cron pipeline", () => {
    // Crons (api.cron.weekly-scan, api.cron.weekly-digest) and the
    // products/themes webhooks all use this list — keep them in sync via
    // the constant rather than hardcoding the values.
    expect([...MONITORING_TIERS].sort()).toEqual(
      ["monitoring", "pro", "recovery"].sort(),
    );
  });
});

describe("hasMonitoringAccess / hasRecoveryAccess access matrix", () => {
  const matrix: Array<[string, boolean, boolean]> = [
    // tier         monitoring  recovery
    ["free", false, false],
    ["shield", false, false],
    ["monitoring", true, false],
    ["recovery", true, true],
    ["pro", true, true], // ← grandfathered Shield Max
  ];

  for (const [tier, expectedMonitoring, expectedRecovery] of matrix) {
    it(`tier='${tier}' → monitoring=${expectedMonitoring}, recovery=${expectedRecovery}`, () => {
      expect(hasMonitoringAccess(tier)).toBe(expectedMonitoring);
      expect(hasRecoveryAccess(tier)).toBe(expectedRecovery);
    });
  }

  it("handles null / undefined defensively (returns false, never throws)", () => {
    expect(hasMonitoringAccess(null)).toBe(false);
    expect(hasMonitoringAccess(undefined)).toBe(false);
    expect(hasRecoveryAccess(null)).toBe(false);
    expect(hasRecoveryAccess(undefined)).toBe(false);
  });

  it("grandfathered pro passes BOTH gates (live Shield Max customer guarantee)", () => {
    // Regression guard for the 2 live paying customers on 2026-05-14.
    // The v3 cutover must not strip features from existing pros.
    expect(hasMonitoringAccess("pro")).toBe(true);
    expect(hasRecoveryAccess("pro")).toBe(true);
  });
});

describe("v3 gate sites use the centralised helpers, not raw tier === comparisons", () => {
  // Recovery-gated
  it("app.appeal-letter.tsx gates loader + action via hasRecoveryAccess", () => {
    const src = read("app", "routes", "app.appeal-letter.tsx");
    expect(src).toContain("hasRecoveryAccess");
    expect(src).not.toMatch(/merchant\.tier\s*===?\s*"pro"/);
  });

  it("app.gtin-fill.tsx loader + action gate on hasRecoveryAccess", () => {
    const src = read("app", "routes", "app.gtin-fill.tsx");
    expect(src).toContain("hasRecoveryAccess");
    expect(src).not.toMatch(/merchant\.tier\s*!==?\s*"pro"/);
  });

  it("AI policy generation action in app._index.tsx gates on hasRecoveryAccess", () => {
    const src = read("app", "routes", "app._index.tsx");
    // The generatePolicy action handler.
    expect(src).toContain("hasRecoveryAccess(merchant.tier)");
  });

  it("AuditChecklist renders Recovery-only policy fix via hasRecoveryAccess", () => {
    const src = read("app", "components", "AuditChecklist.tsx");
    expect(src).toContain("hasRecoveryAccess");
    expect(src).not.toMatch(/tier\s*===\s*"pro"/);
  });

  // Monitoring-gated
  it("api.cron.weekly-scan filters by MONITORING_TIERS", () => {
    const src = read("app", "routes", "api.cron.weekly-scan.ts");
    expect(src).toContain("MONITORING_TIERS");
    expect(src).not.toMatch(/\["shield",\s*"pro"\]/);
  });

  it("api.cron.weekly-digest filters by MONITORING_TIERS", () => {
    const src = read("app", "routes", "api.cron.weekly-digest.ts");
    expect(src).toContain("MONITORING_TIERS");
    expect(src).not.toMatch(/\["shield",\s*"pro"\]/);
  });

  it("api.proxy.llms-txt gates on hasMonitoringAccess", () => {
    const src = read("app", "routes", "api.proxy.llms-txt.ts");
    expect(src).toContain("hasMonitoringAccess");
    expect(src).not.toMatch(/merchant\?\.tier\s*!==?\s*"pro"/);
  });

  it("app.bots.toggle loader + action gate via hasMonitoringAccess", () => {
    const src = read("app", "routes", "app.bots.toggle.tsx");
    expect(src).toContain("hasMonitoringAccess");
  });

  it("app.pro-settings gates on hasMonitoringAccess", () => {
    const src = read("app", "routes", "app.pro-settings.tsx");
    expect(src).toContain("hasMonitoringAccess");
  });

  it("webhooks.themes.update gates the scan trigger via hasMonitoringAccess", () => {
    const src = read("app", "routes", "webhooks.themes.update.tsx");
    expect(src).toContain("hasMonitoringAccess");
  });

  it("webhooks.products.update gates BOTH scan trigger AND ongoing enrichment via hasMonitoringAccess", () => {
    const src = read("app", "routes", "webhooks.products.update.tsx");
    expect(src).toContain("hasMonitoringAccess");
    // Both occurrences:
    expect(src).toMatch(/hasMonitoringAccess\(opts\.tier\)/);
    expect(src).toMatch(/hasMonitoringAccess\(merchant\.tier\)/);
  });

  it("NavMenu in app.tsx hides Recovery + Monitoring nav links via helpers", () => {
    const src = read("app", "routes", "app.tsx");
    expect(src).toContain("hasMonitoringAccess");
    expect(src).toContain("hasRecoveryAccess");
  });
});

describe("Migration SQL widens the merchants.tier CHECK constraint", () => {
  it("migration file exists and widens the CHECK to v3 values", () => {
    const sql = read(
      "supabase",
      "migrations",
      "20260514150228_widen_tier_for_v3_pricing.sql",
    );
    expect(sql).toContain("CHECK (tier IN ('free', 'shield', 'pro', 'monitoring', 'recovery'))");
    // Sanity: the migration must NOT migrate existing pro rows.
    expect(sql).not.toMatch(/UPDATE\s+merchants\s+SET\s+tier/i);
  });
});
