/**
 * Phase 7.3 — Storefront monitoring (originally scan-on-change) tests.
 *
 * v4 (2026-05-28) dropped the automated scan-on-change behavior. The
 * webhook subscription stays (so Shopify keeps the URL registered), and
 * the products/update webhook still enqueues `enrichment` triggers for
 * the GTIN/MPN/brand auto-filler. The themes/update webhook is now a
 * no-op ACK. The cron drainer (process-scan-triggers) only does
 * enrichment work.
 *
 * File-content assertions over the v4 shape of these handlers + cron +
 * the wiring in shopify.app.toml and vercel.json.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");

describe("webhooks.themes.update removed (dead no-op handler)", () => {
  it("the themes handler file no longer exists", () => {
    expect(
      existsSync(join(root, "app", "routes", "webhooks.themes.update.tsx")),
    ).toBe(false);
  });
});

describe("webhooks.products.update — still enqueues triggers (scan + enrichment)", () => {
  const src = readFileSync(
    join(root, "app", "routes", "webhooks.products.update.tsx"),
    "utf8",
  );

  it("calls maybeRecordScanTrigger for paid tiers", () => {
    expect(src).toContain("maybeRecordScanTrigger");
    expect(src).toContain('from("pending_scan_triggers")');
  });

  it("scan-trigger gate is routed through hasPaidAccess helper", () => {
    expect(src).toContain("hasPaidAccess");
    expect(src).toMatch(/if\s*\(\s*!hasPaidAccess\(opts\.tier\)\s*\)/);
  });

  it("scan-trigger has its own 24h dedup window", () => {
    expect(src).toContain("processed_at");
    expect(src).toMatch(/24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  });
});

describe("api.cron.process-scan-triggers (v4 enrichment-only drainer)", () => {
  const src = readFileSync(
    join(root, "app", "routes", "api.cron.process-scan-triggers.ts"),
    "utf8",
  );

  it("uses bearer CRON_SECRET auth", () => {
    expect(src).toContain("CRON_SECRET");
    expect(src).toContain('startsWith("Bearer ")');
  });

  it("processes enrichment triggers individually with payload.product_gid", () => {
    expect(src).toContain("enrichmentRows");
    expect(src).toMatch(/trigger_type === "enrichment"/);
    expect(src).toContain("enrichProductMetafields");
  });

  it("advances legacy non-enrichment trigger rows without scanning", () => {
    // v4 removed scan-class handling — runComplianceScan is no longer
    // imported or called here.
    expect(src).not.toContain("runComplianceScan");
    expect(src).toContain("legacyRows");
  });

  it("marks processed_at on completion", () => {
    expect(src).toContain("processed_at");
    expect(src).toContain('new Date().toISOString()');
    expect(src).toContain('.update({ processed_at:');
  });

  it("drains a bounded batch per invocation to stay under Vercel Hobby's 60s function ceiling", () => {
    expect(src).toMatch(/const\s+BATCH_SIZE\s*=\s*10\b/);
    expect(src).toContain(".limit(BATCH_SIZE)");
  });

  it("scopes the queue head to PAID, installed merchants so free-tier rows can't wedge the drainer", () => {
    expect(src).toContain("merchants!inner");
    expect(src).toContain('.in("merchants.tier", PAID_TIERS');
    expect(src).toContain('.is("merchants.uninstalled_at", null)');
  });

  it("surfaces mark-processed write failures to Sentry instead of swallowing them", () => {
    expect(src).toContain("captureException");
    expect(src).toMatch(/branch: "mark_processed"/);
  });
});

describe("config wiring", () => {
  it("shopify.app.toml no longer subscribes to themes/update + themes/publish (dead no-op removed)", () => {
    const toml = readFileSync(join(root, "shopify.app.toml"), "utf8");
    expect(toml).not.toContain('topics = [ "themes/update", "themes/publish" ]');
    expect(toml).not.toContain('uri = "/webhooks/themes/update"');
  });

  it("vercel.json schedules process-scan-triggers daily (safety net for GH Actions)", () => {
    const vc = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8"));
    const found = vc.crons.find(
      (c: { path: string }) => c.path === "/api/cron/process-scan-triggers",
    );
    expect(found).toBeDefined();
    expect(found.schedule).toBe("0 12 * * *");
  });

  it("schema declares pending_scan_triggers with UUID merchant_id", () => {
    const sql = readFileSync(join(root, "supabase", "schema.sql"), "utf8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS pending_scan_triggers");
    expect(sql).toMatch(/merchant_id\s+UUID/);
  });
});
