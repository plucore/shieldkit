/**
 * tests/product-webhooks.test.ts
 *
 * Per-shop products/* webhook migration.
 *
 * products/create + products/update enrichment is paid-only, but app-level
 * (shopify.app.toml) subscriptions fire for every install regardless of tier —
 * free-tier stores generated ~20k wasted serverless invocations/day. The fix
 * moves products/* to per-shop subscriptions created only for paid merchants
 * (app/lib/webhooks/product-webhooks.server.ts), removes the dead themes/*
 * no-op subscriptions entirely, and closes the drainer leak where a demoted
 * merchant could still get a paid metafield write.
 *
 * File-content assertions, matching the repo's existing test style.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");

// Strip TOML comment lines so prose that *mentions* a removed topic (the
// explanatory note left in shopify.app.toml) can't mask a real subscription.
function tomlWithoutComments(): string {
  return read("shopify.app.toml")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");
}

describe("shopify.app.toml — products/* and themes/* subscriptions removed", () => {
  const toml = tomlWithoutComments();

  it("no longer declares products/create or products/update subscriptions", () => {
    expect(toml).not.toContain("products/create");
    expect(toml).not.toContain("products/update");
  });

  it("no longer declares themes/update or themes/publish subscriptions", () => {
    expect(toml).not.toContain("themes/update");
    expect(toml).not.toContain("themes/publish");
  });

  it("still keeps the required lifecycle / billing / GDPR subscriptions", () => {
    // Sanity: we only dropped the two paid/no-op topics, not the required ones.
    expect(toml).toContain("app/uninstalled");
    expect(toml).toContain("app/scopes_update");
    expect(toml).toContain("app_subscriptions/update");
  });

  it("preserves the read_themes / write_themes access scopes (only the webhook subs were dropped)", () => {
    const raw = read("shopify.app.toml");
    expect(raw).toContain("read_themes");
    expect(raw).toContain("write_themes");
  });
});

describe("product-webhooks.server.ts helper", () => {
  const src = read("app", "lib", "webhooks", "product-webhooks.server.ts");

  it("exports ensureProductWebhooks and removeProductWebhooks", () => {
    expect(src).toMatch(/export\s+async\s+function\s+ensureProductWebhooks/);
    expect(src).toMatch(/export\s+async\s+function\s+removeProductWebhooks/);
  });

  it("uses the webhookSubscriptionCreate + webhookSubscriptionDelete mutations", () => {
    expect(src).toContain("webhookSubscriptionCreate");
    expect(src).toContain("webhookSubscriptionDelete");
  });

  it("only manages products/create + products/update (no other topic)", () => {
    expect(src).toContain("PRODUCTS_CREATE");
    expect(src).toContain("PRODUCTS_UPDATE");
    // Must not subscribe any other topic from this module.
    expect(src).not.toContain("THEMES_UPDATE");
    expect(src).not.toContain("THEMES_PUBLISH");
    expect(src).not.toContain("APP_UNINSTALLED");
  });

  it("builds the callback URL from SHOPIFY_APP_URL and uses background createAdminClient", () => {
    expect(src).toContain("SHOPIFY_APP_URL");
    expect(src).toContain("/webhooks/products/update");
    expect(src).toContain("createAdminClient");
    // Background jobs must NOT use the route-only wrapAdminClient.
    expect(src).not.toContain("wrapAdminClient");
  });

  it("reports errors to Sentry and never throws (best-effort contract)", () => {
    expect(src).toContain("sentry.captureException");
  });
});

describe("call sites are wired up", () => {
  it("app.billing.confirm.tsx ensures product webhooks on the active-paid branch", () => {
    const src = read("app", "routes", "app.billing.confirm.tsx");
    expect(src).toContain("ensureProductWebhooks");
    // Must fire on the active-paid write path, before the dashboard redirect.
    const ensureIdx = src.indexOf("ensureProductWebhooks(session.shop)");
    const redirectIdx = src.indexOf('return redirect("/app")');
    expect(ensureIdx).toBeGreaterThan(0);
    expect(ensureIdx).toBeLessThan(redirectIdx);
  });

  it("reconcile-subscriptions removes product webhooks on demote and ensures on active", () => {
    const src = read("app", "routes", "api.cron.reconcile-subscriptions.ts");
    expect(src).toContain("removeProductWebhooks");
    expect(src).toContain("ensureProductWebhooks");
  });

  it("afterAuth re-provisions product webhooks for paid reinstalls via hasPaidAccess", () => {
    const src = read("app", "shopify.server.ts");
    expect(src).toContain("ensureProductWebhooks");
    expect(src).toContain("hasPaidAccess");
    // The ensure call must live AFTER the merchant upsert (a separate query,
    // not folded into the upsert payload), gated on paid tier. The cleanup
    // batch §6 regression test in bug-fixes.test.ts separately guards that the
    // upsert payload itself never grows.
    const upsertIdx = src.indexOf(".upsert(");
    const ensureIdx = src.indexOf("ensureProductWebhooks(session.shop)");
    expect(upsertIdx).toBeGreaterThan(0);
    expect(ensureIdx).toBeGreaterThan(upsertIdx);
  });

  it("backfill script provisions per-shop webhooks for PAID_TIERS only", () => {
    const src = read("scripts", "backfill-product-webhooks.ts");
    expect(src).toContain("ensureProductWebhooks");
    expect(src).toContain("PAID_TIERS");
    expect(src).toMatch(/is\("uninstalled_at",\s*null\)/);
  });
});

describe("drainer correctness guard (process-scan-triggers)", () => {
  const src = read("app", "routes", "api.cron.process-scan-triggers.ts");

  it("re-checks hasPaidAccess before running enrichProductMetafields", () => {
    expect(src).toContain("hasPaidAccess");
    // The guard must sit before the enrichment metafield write so a merchant
    // demoted after the row was enqueued never gets a paid metafield write.
    const guardIdx = src.indexOf("!hasPaidAccess(merchant.tier)");
    const enrichCallIdx = src.indexOf("await enrichProductMetafields(");
    expect(guardIdx).toBeGreaterThan(0);
    expect(enrichCallIdx).toBeGreaterThan(0);
    expect(guardIdx).toBeLessThan(enrichCallIdx);
  });
});
