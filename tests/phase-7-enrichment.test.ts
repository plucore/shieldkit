/**
 * Phase 7.1 — GTIN/MPN/brand continuous enrichment tests.
 *
 * Mix of pure-function tests (enrichProductMetafields with a mocked
 * admin) and file-content assertions (webhook route exists, references
 * the gates, app.toml has the subscription block). Matches the style
 * of tests/bug-fixes.test.ts.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  enrichProductMetafields,
  gidToNumericId,
} from "../app/lib/enrichment/gtin-enrichment.server";

interface MockGqlResponse {
  data?: unknown;
}

function mockAdmin(handlers: Array<(query: string) => MockGqlResponse>) {
  let i = 0;
  return {
    graphql: vi.fn(async (query: string) => {
      const handler = handlers[Math.min(i, handlers.length - 1)];
      i++;
      const body = handler(query);
      return { json: async () => body };
    }),
  };
}

const PRODUCT_GID = "gid://shopify/Product/123";

describe("gidToNumericId", () => {
  it("extracts numeric id", () => {
    expect(gidToNumericId(PRODUCT_GID)).toBe("123");
  });
  it("returns null for malformed input", () => {
    expect(gidToNumericId("notagid")).toBeNull();
  });
});

describe("enrichProductMetafields", () => {
  it("skips entirely when all metafields already populated", async () => {
    const admin = mockAdmin([
      () => ({
        data: {
          product: {
            id: PRODUCT_GID,
            title: "Test",
            vendor: "Acme",
            variants: { edges: [{ node: { sku: "ABC", barcode: "012345678905" } }] },
            metafields: {
              edges: [
                { node: { key: "gtin", value: "012345678905" } },
                { node: { key: "mpn", value: "ABC" } },
                { node: { key: "brand", value: "Acme" } },
              ],
            },
          },
        },
      }),
    ]);

    const result = await enrichProductMetafields(admin, PRODUCT_GID);
    expect(result.ok).toBe(true);
    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual(["gtin", "mpn", "brand"]);
    // Only the product query — no metafieldsSet mutation.
    expect(admin.graphql).toHaveBeenCalledTimes(1);
  });

  it("writes only the missing metafields", async () => {
    const admin = mockAdmin([
      () => ({
        data: {
          product: {
            id: PRODUCT_GID,
            title: "Test",
            vendor: "Acme",
            variants: { edges: [{ node: { sku: "ABC", barcode: "012345678905" } }] },
            // brand already set; gtin + mpn missing.
            metafields: { edges: [{ node: { key: "brand", value: "Acme" } }] },
          },
        },
      }),
      () => ({ data: { metafieldsSet: { metafields: [], userErrors: [] } } }),
    ]);

    const result = await enrichProductMetafields(admin, PRODUCT_GID);
    expect(result.ok).toBe(true);
    expect(result.written.sort()).toEqual(["gtin", "mpn"]);
    expect(result.skipped).toContain("brand");
  });

  it("honours identifier_exists=false opt-out", async () => {
    const admin = mockAdmin([
      () => ({
        data: {
          product: {
            id: PRODUCT_GID,
            title: "Test",
            vendor: "Acme",
            variants: { edges: [{ node: { sku: "ABC", barcode: "012345678905" } }] },
            metafields: { edges: [{ node: { key: "identifier_exists", value: "false" } }] },
          },
        },
      }),
    ]);

    const result = await enrichProductMetafields(admin, PRODUCT_GID);
    expect(result.ok).toBe(true);
    expect(result.written).toEqual([]);
    expect(admin.graphql).toHaveBeenCalledTimes(1); // no mutation issued
  });

  it("returns ok=false when product not found", async () => {
    const admin = mockAdmin([() => ({ data: { product: null } })]);
    const result = await enrichProductMetafields(admin, PRODUCT_GID);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("product_not_found");
  });

  it("falls back to shop name for brand when vendor is empty", async () => {
    const admin = mockAdmin([
      () => ({
        data: {
          product: {
            id: PRODUCT_GID,
            title: "Test",
            vendor: null,
            variants: { edges: [{ node: { sku: null, barcode: null } }] },
            metafields: { edges: [] },
          },
        },
      }),
      () => ({ data: { shop: { name: "MyShop" } } }),
      () => ({ data: { metafieldsSet: { metafields: [], userErrors: [] } } }),
    ]);

    const result = await enrichProductMetafields(admin, PRODUCT_GID);
    expect(result.ok).toBe(true);
    expect(result.written).toEqual(["brand"]);
  });
});

describe("Phase 7.1 — webhook + config wiring", () => {
  const root = join(__dirname, "..");

  it("webhooks.products.update.tsx exports an action", () => {
    const src = readFileSync(
      join(root, "app", "routes", "webhooks.products.update.tsx"),
      "utf8",
    );
    expect(src).toMatch(/export const action/);
  });

  it("webhook references all three gate strings", () => {
    const src = readFileSync(
      join(root, "app", "routes", "webhooks.products.update.tsx"),
      "utf8",
    );
    expect(src).toContain("skip_tier");
    expect(src).toContain("skip_scope");
    expect(src).toContain("skip_dedup");
  });

  it("webhook uses the shared HMAC pattern (authenticate.webhook)", () => {
    const src = readFileSync(
      join(root, "app", "routes", "webhooks.products.update.tsx"),
      "utf8",
    );
    expect(src).toContain("authenticate.webhook(request)");
  });

  it("shopify.app.toml subscribes to products/create + products/update", () => {
    const toml = readFileSync(join(root, "shopify.app.toml"), "utf8");
    expect(toml).toMatch(/products\/create.*products\/update|products\/update.*products\/create/s);
    expect(toml).toContain('uri = "/webhooks/products/update"');
  });

  it("schema.sql declares enrichment_webhook_log with UUID merchant_id", () => {
    const sql = readFileSync(join(root, "supabase", "schema.sql"), "utf8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS enrichment_webhook_log");
    expect(sql).toMatch(/merchant_id\s+UUID/);
  });
});
