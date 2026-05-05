/**
 * Phase 7.3 — Storefront monitoring (scan-on-change) tests.
 * File-content assertions over the new webhook + cron route plus
 * the wiring in shopify.app.toml and vercel.json.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");

describe("webhooks.themes.update", () => {
  const src = readFileSync(
    join(root, "app", "routes", "webhooks.themes.update.tsx"),
    "utf8",
  );

  it("exports an action", () => {
    expect(src).toMatch(/export const action/);
  });

  it("uses the shared HMAC pattern", () => {
    expect(src).toContain("authenticate.webhook(request)");
  });

  it("acks 200 on free tier (skip_tier branch)", () => {
    // Tier gate: tier IN ('shield','pro') means free returns ack() early.
    expect(src).toContain('merchant.tier !== "shield"');
    expect(src).toContain('merchant.tier !== "pro"');
  });

  it("inserts pending_scan_triggers row for paid tiers", () => {
    expect(src).toContain('from("pending_scan_triggers")');
    expect(src).toContain(".insert(");
    expect(src).toContain("trigger_type");
  });

  it("dedups within a 24h window of unprocessed triggers", () => {
    expect(src).toContain("DEDUP_WINDOW_MS");
    expect(src).toContain("24 * 60 * 60 * 1000");
    expect(src).toContain('.is("processed_at", null)');
  });
});

describe("webhooks.products.update — also enqueues scan triggers", () => {
  const src = readFileSync(
    join(root, "app", "routes", "webhooks.products.update.tsx"),
    "utf8",
  );

  it("calls maybeRecordScanTrigger for paid tiers", () => {
    expect(src).toContain("maybeRecordScanTrigger");
    expect(src).toContain('from("pending_scan_triggers")');
  });

  it("scan-trigger gate accepts shield + pro tiers", () => {
    expect(src).toContain('opts.tier !== "shield"');
    expect(src).toContain('opts.tier !== "pro"');
  });

  it("scan-trigger has its own 24h dedup window", () => {
    expect(src).toContain("processed_at");
    expect(src).toMatch(/24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  });
});

describe("api.cron.process-scan-triggers", () => {
  const src = readFileSync(
    join(root, "app", "routes", "api.cron.process-scan-triggers.ts"),
    "utf8",
  );

  it("uses bearer CRON_SECRET auth", () => {
    expect(src).toContain("CRON_SECRET");
    expect(src).toContain('startsWith("Bearer ")');
  });

  it("groups multiple triggers per merchant into a single scan", () => {
    expect(src).toContain("triggersByMerchant");
    expect(src).toContain("runComplianceScan");
    // single Map keyed by merchant_id; each merchant scanned once
    expect(src).toMatch(/triggersByMerchant\.set\(/);
  });

  it("marks processed_at on completion", () => {
    expect(src).toContain("processed_at");
    expect(src).toContain('new Date().toISOString()');
    expect(src).toContain('.update({ processed_at:');
  });

  it("inserts merchant delay between scans", () => {
    expect(src).toContain("MERCHANT_DELAY_MS");
    expect(src).toContain("sleep(MERCHANT_DELAY_MS)");
  });
});

describe("config wiring", () => {
  it("shopify.app.toml subscribes to themes/update + themes/publish", () => {
    const toml = readFileSync(join(root, "shopify.app.toml"), "utf8");
    expect(toml).toMatch(/themes\/update/);
    expect(toml).toMatch(/themes\/publish/);
    expect(toml).toContain('uri = "/webhooks/themes/update"');
  });

  it("vercel.json schedules process-scan-triggers daily", () => {
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
