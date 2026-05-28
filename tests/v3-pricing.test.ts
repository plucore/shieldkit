/**
 * tests/v3-pricing.test.ts
 *
 * Plan reference data + access-helper assertions.
 *
 * v4 (2026-05-28) collapsed Monitoring + Recovery into a single paid tier
 * called Monitoring, and replaced the two-helper split (hasMonitoringAccess
 * / hasRecoveryAccess) with a single hasPaidAccess. The previous Recovery
 * plan-name + tier value still exist in the DB CHECK constraint and the
 * helpers' acceptance list for grandfathered subscriptions, but the plan
 * is no longer offered.
 *
 *  - hasPaidAccess returns true for monitoring | recovery | pro
 *    (every current + legacy paid tier).
 *  - PLAN_NAME_TO_TIER / PLAN_NAME_TO_CYCLE include both the v4 current
 *    plans AND grandfathered Shield Pro / Shield Max plan strings so the
 *    2 live paying customers continue to reconcile correctly.
 *  - Every gate-site call uses the helper (centralised) rather than raw
 *    `tier === "..."` comparisons.
 *
 * Filename is kept (`v3-pricing.test.ts`) for git history continuity;
 * the assertions now describe the v4 model.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PLAN_NAME_TO_TIER,
  PLAN_NAME_TO_CYCLE,
  PAID_TIERS,
  hasPaidAccess,
} from "../app/lib/billing/plans";

const root = join(__dirname, "..");
const read = (...parts: string[]) =>
  readFileSync(join(root, ...parts), "utf8");

describe("v4 plan reference data", () => {
  it("PLAN_NAME_TO_TIER includes the two current Monitoring plan-name strings", () => {
    expect(PLAN_NAME_TO_TIER["Monitoring"]).toBe("monitoring");
    expect(PLAN_NAME_TO_TIER["Monitoring Annual"]).toBe("monitoring");
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

  it("PLAN_NAME_TO_CYCLE covers all current + grandfathered plans", () => {
    expect(PLAN_NAME_TO_CYCLE["Monitoring"]).toBe("monthly");
    expect(PLAN_NAME_TO_CYCLE["Monitoring Annual"]).toBe("annual");
    expect(PLAN_NAME_TO_CYCLE["Shield Pro"]).toBe("monthly");
    expect(PLAN_NAME_TO_CYCLE["Shield Pro Annual"]).toBe("annual");
    expect(PLAN_NAME_TO_CYCLE["Shield Max"]).toBe("monthly");
    expect(PLAN_NAME_TO_CYCLE["Shield Max Annual"]).toBe("annual");
  });

  it("PAID_TIERS lists every DB tier value that resolves to paid access", () => {
    expect([...PAID_TIERS].sort()).toEqual(
      ["monitoring", "pro", "recovery"].sort(),
    );
  });
});

describe("hasPaidAccess access matrix (v4 single paid gate)", () => {
  const matrix: Array<[string, boolean]> = [
    // tier         paid
    ["free", false],
    ["shield", false],         // grandfathered, zero live rows
    ["monitoring", true],
    ["recovery", true],        // grandfathered after v4 collapse
    ["pro", true],             // grandfathered Shield Max
  ];

  for (const [tier, expected] of matrix) {
    it(`tier='${tier}' → paid=${expected}`, () => {
      expect(hasPaidAccess(tier)).toBe(expected);
    });
  }

  it("handles null / undefined defensively (returns false, never throws)", () => {
    expect(hasPaidAccess(null)).toBe(false);
    expect(hasPaidAccess(undefined)).toBe(false);
  });

  it("grandfathered pro and recovery both pass (live Shield Max + future-proof)", () => {
    // Regression guard for the 2 live paying customers on 2026-05-14.
    // The v3 cutover + v4 collapse must not strip features from existing
    // rows whose tier value is pro or recovery.
    expect(hasPaidAccess("pro")).toBe(true);
    expect(hasPaidAccess("recovery")).toBe(true);
  });
});

describe("v4 gate sites use the centralised hasPaidAccess (not raw tier === comparisons)", () => {
  it("app.appeal-letter.tsx gates loader + action via hasPaidAccess", () => {
    const src = read("app", "routes", "app.appeal-letter.tsx");
    expect(src).toContain("hasPaidAccess");
    expect(src).not.toContain("hasRecoveryAccess");
    expect(src).not.toMatch(/merchant\.tier\s*===?\s*"pro"/);
  });

  it("app.gtin-fill.tsx loader + action gate on hasPaidAccess", () => {
    const src = read("app", "routes", "app.gtin-fill.tsx");
    expect(src).toContain("hasPaidAccess");
    expect(src).not.toContain("hasRecoveryAccess");
    expect(src).not.toMatch(/merchant\.tier\s*!==?\s*"pro"/);
  });

  it("AI policy generation action in app._index.tsx gates on hasPaidAccess", () => {
    const src = read("app", "routes", "app._index.tsx");
    expect(src).toContain("hasPaidAccess(merchant.tier)");
    expect(src).not.toContain("hasRecoveryAccess");
  });

  it("AuditChecklist renders paid-only policy fix via hasPaidAccess", () => {
    const src = read("app", "components", "AuditChecklist.tsx");
    expect(src).toContain("hasPaidAccess");
    expect(src).not.toContain("hasRecoveryAccess");
    expect(src).not.toMatch(/tier\s*===\s*"pro"/);
  });

  it("api.proxy.llms-txt gates on hasPaidAccess", () => {
    const src = read("app", "routes", "api.proxy.llms-txt.ts");
    expect(src).toContain("hasPaidAccess");
    expect(src).not.toContain("hasMonitoringAccess");
    expect(src).not.toMatch(/merchant\?\.tier\s*!==?\s*"pro"/);
  });

  it("app.bots.toggle loader + action gate via hasPaidAccess", () => {
    const src = read("app", "routes", "app.bots.toggle.tsx");
    expect(src).toContain("hasPaidAccess");
    expect(src).not.toContain("hasMonitoringAccess");
  });

  it("app.pro-settings gates on hasPaidAccess", () => {
    const src = read("app", "routes", "app.pro-settings.tsx");
    expect(src).toContain("hasPaidAccess");
    expect(src).not.toContain("hasMonitoringAccess");
  });

  it("webhooks.products.update gates BOTH scan trigger AND ongoing enrichment via hasPaidAccess", () => {
    const src = read("app", "routes", "webhooks.products.update.tsx");
    expect(src).toContain("hasPaidAccess");
    expect(src).not.toContain("hasMonitoringAccess");
    expect(src).toMatch(/hasPaidAccess\(opts\.tier\)/);
    expect(src).toMatch(/hasPaidAccess\(merchant\.tier\)/);
  });

  it("NavMenu in app.tsx hides paid-only nav links via hasPaidAccess", () => {
    const src = read("app", "routes", "app.tsx");
    expect(src).toContain("hasPaidAccess");
    expect(src).not.toContain("hasMonitoringAccess");
    expect(src).not.toContain("hasRecoveryAccess");
  });
});

describe("Migration SQL widens the merchants.tier CHECK constraint", () => {
  it("migration file exists and widens the CHECK to v3 values (still in force)", () => {
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
