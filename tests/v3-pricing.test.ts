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
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  PLAN_NAME_TO_TIER,
  PLAN_NAME_TO_CYCLE,
  PAID_TIERS,
  PLANS,
  PAID_FEATURES,
  FREE_FEATURES,
  TIER_GROUPS,
  annualSavings,
  cycleFromChargeAmount,
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

  it("Recovery plan name is removed from the name maps (no longer offered)", () => {
    // v4 collapsed Recovery into Monitoring. The DB tier value 'recovery'
    // is still valid (CHECK constraint + helper accepts it for grand-
    // fathering), but new merchants cannot reach it through plan-name.
    expect((PLAN_NAME_TO_TIER as Record<string, unknown>)["Recovery"]).toBeUndefined();
    expect((PLAN_NAME_TO_CYCLE as Record<string, unknown>)["Recovery"]).toBeUndefined();
  });

  // CORRECTED 2026-07-28. This test previously asserted 49/390 — the values the
  // code declared, which NEVER matched a real charge. Verified against the
  // Partner API: every real (test:false) Monitoring activation bills $29.00
  // (cq3dar-gv 2026-07-07, sex-eshop 2026-07-12, 9973f3-3 2026-07-25), and the
  // Monthly $29 is confirmed against real Partner API charges. ANNUAL is $299,
  // read off the Shopify App Store listing on 2026-07-29 — NOT off the charge
  // history. The only annual charge that has ever existed is $290 (ygxib5-9s,
  // 2026-05-18), and taking that as the current price is exactly how this
  // constant became wrong the second time: a past charge tells you what was
  // billed then, only the listing tells you what a new subscriber pays now.
  // Price history: $30 (pre-v4) → $39 → $29 monthly; annual 390 → 290 → 299.
  it("Monitoring is priced at $29/mo and $299/yr (per the live App Store listing)", () => {
    expect(PLANS.monitoring_monthly.monthly).toBe(29);
    expect(PLANS.monitoring_annual.annual).toBe(299);
  });

  it("PLANS no longer exposes a recovery_annual entry", () => {
    expect((PLANS as Record<string, unknown>)["recovery_annual"]).toBeUndefined();
  });

  it("TIER_GROUPS has one group ('monitoring') at the current price", () => {
    expect(Object.keys(TIER_GROUPS)).toEqual(["monitoring"]);
    expect(TIER_GROUPS.monitoring.monthlyPrice).toBe(29);
    expect(TIER_GROUPS.monitoring.annualPrice).toBe(299);
  });

  it("annualSavings reports the monthly-vs-annual gap", () => {
    // 29×12 = 348, minus 299 = 49.
    expect(annualSavings()).toBe(49);
  });

  it("PAID_FEATURES is the single canonical paid feature list", () => {
    expect(PAID_FEATURES).toContain("Unlimited store scans, re-check anytime");
    expect(PAID_FEATURES).toContain("Appeal letters to help lift a Google suspension");
    expect(PAID_FEATURES).toContain("Auto-fill the product IDs Google requires");
    // The v3 "Everything in Monitoring, plus:" header is gone — there's
    // only one paid tier in v4.
    expect(PAID_FEATURES.some((f) => f.includes("Everything in Monitoring"))).toBe(false);
  });

  it("FREE_FEATURES describes one-time scan, not monthly", () => {
    expect(FREE_FEATURES).toContain("One free store scan");
    expect(FREE_FEATURES.some((f) => /per month|monthly/i.test(f))).toBe(false);
  });

  it("PAID_TIERS lists every DB tier value that resolves to paid access", () => {
    expect([...PAID_TIERS].sort()).toEqual(
      ["monitoring", "pro", "recovery"].sort(),
    );
  });
});

describe("cycleFromChargeAmount — Partner API cycle resolution (2026-06 collapse)", () => {
  // Post-collapse, "Monitoring" monthly + annual share ONE plan name, so the
  // Partner API path cannot read cycle from the name and must use the amount.
  //
  // REWRITTEN 2026-07-28. The old version asserted 49 → monthly / 390 → annual
  // and, critically, that an unmatched amount returns null. Both were wrong in a
  // way that hid a real defect: because the constants never matched a real
  // charge, EVERY live charge fell through to null, and the caller's
  // PLAN_NAME_TO_CYCLE fallback maps the collapsed "Monitoring" name to
  // "monthly" unconditionally — so a real ANNUAL subscriber would have been
  // silently recorded as monthly.
  it("resolves the real live prices exactly", () => {
    expect(cycleFromChargeAmount("monitoring", 29)).toBe("monthly");
    expect(cycleFromChargeAmount("monitoring", 299)).toBe("annual");
  });

  // THE ORIGINAL DEFECT, pinned at every price this plan has ever carried.
  // A future annual subscriber silently resolving to `monthly` is the failure
  // that started all of this, so each historical annual figure is asserted
  // alongside the current one: 299 by exact match, 290 and 390 structurally.
  it("resolves EVERY annual figure this plan has carried as annual", () => {
    for (const amount of [299, 290, 390]) {
      expect(cycleFromChargeAmount("monitoring", amount), `${amount} must be annual`).toBe(
        "annual",
      );
    }
    // ...and the monthly ones as monthly, including the stale 49 constant.
    for (const amount of [29, 39, 49]) {
      expect(cycleFromChargeAmount("monitoring", amount), `${amount} must be monthly`).toBe(
        "monthly",
      );
    }
    // $0 still carries no cycle at all.
    expect(cycleFromChargeAmount("monitoring", 0)).toBeNull();
  });

  it("disambiguates grandfathered tiers by their own price points", () => {
    // Shield Max Annual is $390/yr — tier 'pro', resolved from the plan name
    // first, so the amount lookup is scoped and never collides with Monitoring.
    expect(cycleFromChargeAmount("pro", 39)).toBe("monthly");
    expect(cycleFromChargeAmount("pro", 390)).toBe("annual");
    expect(cycleFromChargeAmount("shield", 14)).toBe("monthly");
    expect(cycleFromChargeAmount("shield", 140)).toBe("annual");
  });

  // The robustness property: correct cycle even when the constants are stale,
  // which is the failure mode that actually occurred. These amounts match no
  // declared price point.
  it("falls back STRUCTURALLY on an unknown amount instead of returning null", () => {
    // A price rise: still obviously monthly, well under 6x the monthly price.
    expect(cycleFromChargeAmount("monitoring", 49)).toBe("monthly");
    expect(cycleFromChargeAmount("monitoring", 39)).toBe("monthly");
    // A discounted / promotional annual: an order of magnitude up, so annual.
    expect(cycleFromChargeAmount("monitoring", 199)).toBe("annual");
    expect(cycleFromChargeAmount("monitoring", 390)).toBe("annual");
    expect(cycleFromChargeAmount("monitoring", 12345)).toBe("annual");
  });

  it("survives the exact historical staleness that caused the bug", () => {
    // Constants said 49/390 while reality billed 29/290. Under the OLD exact-
    // match-or-null logic both real amounts returned null. They must not now.
    expect(cycleFromChargeAmount("monitoring", 29)).not.toBeNull();
    expect(cycleFromChargeAmount("monitoring", 290)).not.toBeNull();
    expect(cycleFromChargeAmount("monitoring", 299)).not.toBeNull();
  });

  it("returns null only when there is genuinely no cycle to infer", () => {
    expect(cycleFromChargeAmount("free", 29)).toBeNull(); // tier has no price points
    expect(cycleFromChargeAmount("recovery", 290)).toBeNull(); // tier has no price points
    expect(cycleFromChargeAmount(null, 290)).toBeNull();
    expect(cycleFromChargeAmount("monitoring", null)).toBeNull();
    expect(cycleFromChargeAmount("monitoring", Number.NaN)).toBeNull();
    // $0 carries no cycle: free plans (incl. Shopify's localised "Gratuit",
    // "Gratis", "Grátis", "Gratuito", "Kostenlos" variants) and test charges.
    expect(cycleFromChargeAmount("monitoring", 0)).toBeNull();
    expect(cycleFromChargeAmount("monitoring", -5)).toBeNull();
  });
});

// ─── Public pricing surfaces must DERIVE from PLANS, never hardcode ──────────
// The landing page advertised $49/mo + $390/yr + "Save $198/yr" in four places
// while Shopify charged $29 — 69% above the real price, on the highest-traffic
// public surface the product has, for weeks. It drifted because the numbers were
// string literals with no link to billing.
describe("public marketing surfaces cannot drift from PLANS", () => {
  const landing = readFileSync(
    join(process.cwd(), "app", "routes", "_index", "route.tsx"),
    "utf8",
  );

  it("the landing page imports its prices from plans.ts", () => {
    expect(landing).toMatch(
      /import\s*\{[^}]*\bPLANS\b[^}]*\}\s*from\s*["'][^"']*lib\/billing\/plans["']/,
    );
    expect(landing).toMatch(/\bannualSavings\b/);
  });

  it("the landing page hardcodes NO ShieldKit plan price", () => {
    // Strip comments — the file explains the old wrong numbers in prose.
    const code = landing
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    // Any dollar-amount literal that looks like a plan price is a regression.
    // Free is "$0" and is legitimately fixed, so it is exempt.
    const literals = code.match(/["'`]\$\d[\d,]*(?:\.\d+)?/g) ?? [];
    const offenders = literals.filter((s) => !/^["'`]\$0$/.test(s));
    expect(offenders).toEqual([]);
    // And the specific historical wrong values must never reappear anywhere.
    // $290 joined this list on 2026-07-29: it was itself a "correction" of $390,
    // inferred from the single historical annual charge rather than from the
    // live listing, and the real listed price turned out to be $299.
    for (const stale of ["$49", "$390", "$449", "$198", "$290"]) {
      expect(code).not.toContain(stale);
    }
  });

  it("evergreen blog copy carries no plan price and no retired tier name", () => {
    // Blog posts are prerendered and long-lived, so an embedded price is
    // guaranteed to go stale. Three posts advertised "Shield Pro ($14/month)"
    // and "Shield Max ($39/month)" — tiers that no longer exist — and two
    // promised an email digest that never sent a single message.
    const dir = join(process.cwd(), "app", "content", "blog");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".mdx"))) {
      const body = readFileSync(join(dir, file), "utf8");
      for (const dead of ["Shield Pro", "Shield Max", "Recovery tier"]) {
        expect(body, `${file} references retired tier "${dead}"`).not.toContain(dead);
      }
      // "$14/month" / "$39/month" / "$49/mo" style plan pricing.
      expect(body, `${file} hardcodes a plan price`).not.toMatch(
        /\$\d+(?:\.\d+)?\s*\/?\s*(?:month|mo|year|yr)\b/i,
      );
      // The digest was deleted in v4 and never sent an email.
      expect(body, `${file} promises an email digest`).not.toMatch(
        /emails? you a digest|digest of changes/i,
      );
    }
  });
});

// ─── Regression guards for the 2026-07-28 entitlement-loss incident ──────────
// A superseded-subscription cancellation demoted a live $29/mo customer
// (9973f3-3.myshopify.com / Wanok Cosmetics), and FROZEN — a recoverable state —
// was treated as terminal, demoting two more paying merchants.
describe("app_subscriptions/update must not destroy a live entitlement", () => {
  const src = readFileSync(
    join(process.cwd(), "app", "routes", "webhooks.app_subscriptions.update.tsx"),
    "utf8",
  );
  // Strip comments: the file documents the old broken behaviour in prose, and a
  // naive match would hit the explanation rather than the code.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
    .join("\n");

  it("FROZEN is NOT terminal — a freeze is recoverable, not a cancellation", () => {
    // The set moved to plans.ts on 2026-07-29 and is now SHARED with
    // reconcile-subscriptions. This test used to pin the webhook's local copy,
    // which is precisely why the cron's second copy kept "frozen" for a day
    // without anything failing. Assert against the single source.
    const plans = readFileSync(
      join(__dirname, "..", "app", "lib", "billing", "plans.ts"),
      "utf8",
    );
    const m = plans.match(
      /export const TERMINAL_SUBSCRIPTION_STATUSES: readonly string\[\] = \[([\s\S]*?)\];/,
    );
    expect(m).not.toBeNull();
    expect(m![1]).not.toMatch(/frozen/i);
    expect(code).not.toMatch(/const TERMINAL_STATUSES/);
    expect(code).toMatch(/isTerminalSubscriptionStatus\(status\)/);
  });

  it("FROZEN is handled explicitly and leaves entitlement intact", () => {
    // Must short-circuit BEFORE the demote block, not fall through to it.
    const frozenIdx = code.indexOf('status === "FROZEN"');
    const demoteIdx = code.indexOf("isTerminalSubscriptionStatus(status)");
    expect(frozenIdx).toBeGreaterThan(-1);
    expect(demoteIdx).toBeGreaterThan(-1);
    expect(frozenIdx).toBeLessThan(demoteIdx);
  });

  it("an UNFROZEN merchant is re-entitled (arrives as status=ACTIVE)", () => {
    // There is no "UNFROZEN" webhook status — UNFROZEN is a Partner API event
    // type that surfaces here as a plain ACTIVE. So the requirement is that the
    // ACTIVE branch unconditionally restores the paid tier and unlimited scans.
    const activeIdx = code.indexOf('status === "ACTIVE"');
    expect(activeIdx).toBeGreaterThan(-1);
    const activeBlock = code.slice(activeIdx, code.indexOf("isTerminalSubscriptionStatus(status)"));
    expect(activeBlock).toMatch(/scans_remaining:\s*null/);
    expect(activeBlock).toMatch(/shopify_subscription_id:\s*admin_graphql_api_id/);
    expect(activeBlock).toMatch(/\btier\b/);
  });

  it("demote is gated on the event matching the TRACKED subscription id", () => {
    const demoteIdx = code.indexOf("isTerminalSubscriptionStatus(status)");
    const block = code.slice(demoteIdx);
    // Reads the stored id...
    expect(block).toMatch(/select\(\s*["'][^"']*shopify_subscription_id/);
    // ...and refuses to demote when it is absent or does not match.
    expect(block).toMatch(/stored\s*!==\s*admin_graphql_api_id/);
    expect(block).toMatch(/if\s*\(\s*!stored\s*\)/);
    // The guard must precede the UPDATE it protects.
    expect(block.indexOf("stored !== admin_graphql_api_id")).toBeLessThan(
      block.indexOf('tier: "free"'),
    );
  });

  it("fails CLOSED — an unreadable merchant row must not trigger a demote", () => {
    const block = code.slice(code.indexOf("isTerminalSubscriptionStatus(status)"));
    expect(block).toMatch(/readErr/);
    expect(block.indexOf("readErr")).toBeLessThan(block.indexOf('tier: "free"'));
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
