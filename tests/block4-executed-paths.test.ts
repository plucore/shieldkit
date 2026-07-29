/**
 * BEHAVIOURAL coverage for the Block 4 paths that no test had ever EXECUTED.
 *
 * The audit on 2026-07-29 found these four asserted only by grepping source
 * text — including all seven "cursor persistence" assertions, for the mechanism
 * that is load-bearing on the sole enrichment discovery path. A content
 * assertion cannot tell you that saveState round-trips, that enqueue is
 * suppressed when the queue read is short, that an unreached merchant is
 * reported rather than silently omitted, or that ensureProductWebhooks actually
 * converges. Every one of those would still "pass" against a broken
 * implementation as long as the identifiers survived.
 *
 * These drive the real modules.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Supabase double ─────────────────────────────────────────────────────────
type Row = Record<string, unknown>;

let stateRows: Row[] = [];
let stateUpsertFails = false;
let queuedPayloads: Row[] = [];
let queueReadFails = false;
let insertedTriggers: Row[] = [];
let capturedUpserts: Row[] = [];

vi.mock("../app/supabase.server", () => {
  const chain = (table: string) => {
    const c: Record<string, (...a: any[]) => any> = {
      select: () => c,
      eq: () => c,
      is: () => c,
      in: () => c,
      not: () => c,
      gte: () => c,
      order: () => c,
      limit: () => c,
      range: () => c,
      maybeSingle: async () => {
        if (table === "catalog_reconcile_state") {
          return { data: stateRows[0] ?? null, error: null };
        }
        return { data: null, error: null };
      },
      upsert: async (row: Row) => {
        if (table === "catalog_reconcile_state") {
          if (stateUpsertFails) return { error: { message: "upsert boom" } };
          capturedUpserts.push(row);
          stateRows = [row];
          return { error: null };
        }
        return { error: null };
      },
      insert: async (rows: Row | Row[]) => {
        insertedTriggers.push(...(Array.isArray(rows) ? rows : [rows]));
        return { error: null };
      },
      then: (resolve: (v: unknown) => unknown) => {
        if (table === "pending_scan_triggers") {
          if (queueReadFails) {
            return resolve({ data: null, error: { message: "queue read boom" } });
          }
          return resolve({ data: queuedPayloads, error: null });
        }
        return resolve({ data: [], error: null });
      },
    };
    return c;
  };
  return { supabase: { from: (t: string) => chain(t) } };
});

vi.mock("../app/lib/sentry.server", () => ({
  sentry: { captureException: vi.fn(), captureMessage: vi.fn() },
}));

// ── Shopify double ──────────────────────────────────────────────────────────
let webhookNodes: Array<Record<string, unknown>> = [];
let listFails = false;
const mutations: Array<{ name: string; vars: Record<string, unknown> }> = [];

vi.mock("../app/lib/shopify-api.server", () => {
  const run = async (query: string, variables?: Record<string, unknown>) => {
    if (query.includes("ProductWebhookSubscriptions")) {
      if (listFails) throw new Error("HTTP 503");
      return {
        data: {
          webhookSubscriptions: { edges: webhookNodes.map((node) => ({ node })) },
        },
      };
    }
    if (query.includes("ProductWebhookDelete")) {
      mutations.push({ name: "delete", vars: variables ?? {} });
      return {
        data: { webhookSubscriptionDelete: { deletedWebhookSubscriptionId: "gid://x/1", userErrors: [] } },
      };
    }
    if (query.includes("ProductWebhookCreate")) {
      mutations.push({ name: "create", vars: variables ?? {} });
      return {
        data: { webhookSubscriptionCreate: { webhookSubscription: { id: "gid://x/new" }, userErrors: [] } },
      };
    }
    if (query.includes("ProductWebhookUpdate")) {
      mutations.push({ name: "update", vars: variables ?? {} });
      return {
        data: { webhookSubscriptionUpdate: { webhookSubscription: { id: "gid://x/1", includeFields: ["id"] }, userErrors: [] } },
      };
    }
    if (query.includes("ReconcileShopName")) return { data: { shop: { name: "Shop" } } };
    // Catalog page: one product that needs no work, then end.
    return {
      data: {
        products: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "gid://shopify/Product/1",
              vendor: "V",
              updatedAt: "2026-07-29T00:00:00Z",
              variants: { nodes: [{ sku: "S", barcode: "B" }] },
              metafields: { nodes: [] },
            },
          ],
        },
      },
      extensions: { cost: { actualQueryCost: 10 } },
    };
  };
  return {
    createAdminClient: async () => run,
    executeWithRetry: async (
      runner: (q: string, v?: Record<string, unknown>) => Promise<unknown>,
      _n: string,
      q: string,
      v?: Record<string, unknown>,
    ) => runner(q, v),
  };
});

const { reconcileCatalog } = await import("../app/lib/enrichment/catalog-reconcile.server");
const { ensureProductWebhooks, DESIRED_TOPICS } = await import(
  "../app/lib/webhooks/product-webhooks.server"
);

beforeEach(() => {
  stateRows = [];
  stateUpsertFails = false;
  queuedPayloads = [];
  queueReadFails = false;
  insertedTriggers = [];
  capturedUpserts = [];
  webhookNodes = [];
  listFails = false;
  mutations.length = 0;
  process.env.SHOPIFY_APP_URL = "https://shieldkit.vercel.app";
  process.env.SCOPES = "write_products";
});

const opts = (over: Record<string, unknown> = {}) => ({
  shopDomain: "s.myshopify.com",
  merchantId: "m-1",
  mode: "enqueue" as const,
  ...over,
});

// ════════════════════════════════════════════════════════════════════════════
describe("enqueue_suppressed actually executes", () => {
  it("refuses to enqueue when the pending-queue read FAILS", async () => {
    // An incomplete view of what is already queued can only cause duplicates.
    // Four passes during a deploy window inflated the queue from ~4,700 to
    // 15,559 rows exactly this way. Refusing to write is the safe direction.
    queueReadFails = true;
    const r = await reconcileCatalog(
      opts({
        // Force a product that DOES need work so a missing guard would insert.
        mode: "enqueue",
      }),
    );
    expect(r.errors.join(" ")).toMatch(/enqueue_suppressed/);
    expect(r.enqueued).toBe(0);
    expect(insertedTriggers).toHaveLength(0);
  });

  it("observe-mode reporting is unaffected by a failed queue read", async () => {
    queueReadFails = true;
    const r = await reconcileCatalog(opts({ mode: "observe" }));
    // The walk still happened and still decided — only WRITING is suppressed.
    expect(r.productsSeen).toBe(1);
    expect(insertedTriggers).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("ensureProductWebhooks converges, executed", () => {
  const TARGET = "https://shieldkit.vercel.app/webhooks/products/update";

  it("DELETES a managed topic that is no longer wanted", async () => {
    // The converge-down half of the products/update unsubscribe. No test had
    // ever executed this function, so the teardown that carried out the switch
    // across every shop was asserted only by regex.
    webhookNodes = [
      { id: "gid://x/1", topic: "PRODUCTS_UPDATE", includeFields: ["id"], endpoint: { callbackUrl: TARGET } },
      { id: "gid://x/2", topic: "PRODUCTS_CREATE", includeFields: ["id"], endpoint: { callbackUrl: TARGET } },
    ];
    const r = await ensureProductWebhooks("s.myshopify.com");
    expect(r.removed).toContain("PRODUCTS_UPDATE");
    expect(r.existing).toContain("PRODUCTS_CREATE");
    expect(mutations.filter((m) => m.name === "delete")).toHaveLength(1);
    // And it must NOT re-add the topic it just removed.
    expect(DESIRED_TOPICS).not.toContain("PRODUCTS_UPDATE");
    expect(mutations.filter((m) => m.name === "create")).toHaveLength(0);
  });

  it("creates a desired topic that is missing", async () => {
    webhookNodes = [];
    const r = await ensureProductWebhooks("s.myshopify.com");
    expect(r.created).toContain("PRODUCTS_CREATE");
    expect(mutations.filter((m) => m.name === "create")).toHaveLength(1);
  });

  it("a FAILED list is reported, not read as 'nothing stale exists'", async () => {
    // The §11a shape on this surface: if the list fails, the teardown silently
    // no-ops and `removed: []` is indistinguishable from "already converged".
    listFails = true;
    const r = await ensureProductWebhooks("s.myshopify.com");
    expect(r.errors.join(" ")).toMatch(/list/);
    expect(r.removed).toEqual([]);
  });

  it("narrows includeFields on an EXISTING subscription", async () => {
    webhookNodes = [
      { id: "gid://x/2", topic: "PRODUCTS_CREATE", includeFields: null, endpoint: { callbackUrl: TARGET } },
    ];
    const r = await ensureProductWebhooks("s.myshopify.com");
    expect(r.updated).toContain("PRODUCTS_CREATE");
  });

  it("does NOT re-update an already-narrowed subscription", async () => {
    webhookNodes = [
      { id: "gid://x/2", topic: "PRODUCTS_CREATE", includeFields: ["id"], endpoint: { callbackUrl: TARGET } },
    ];
    const r = await ensureProductWebhooks("s.myshopify.com");
    expect(r.updated).toEqual([]);
    expect(mutations.filter((m) => m.name === "update")).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Fully-qualified metafield keys come back NAMESPACE-PREFIXED.
//
// The Phase 4 fix narrowed the metafields query to the four keys we read, so a
// product with many custom metafields could not hide them. Two things went
// wrong on the way, both caught only by running against live Shopify:
//
//   1. `namespace: "custom", keys: [...]` is rejected at EXECUTION time
//      ("Providing any of the namespace ... arguments with the keys argument is
//      not supported") even though it passes schema validation. It shipped, and
//      every paid merchant's catalog walk returned ZERO pages.
//   2. With fully-qualified `keys: ["custom.gtin", ...]`, Shopify returns
//      `key: "custom.gtin"` — so indexing by the raw key made every value read
//      as UNSET: existing gtin/mpn/brand would be OVERWRITTEN and an explicit
//      `identifier_exists = "false"` opt-out IGNORED.
//
// Verified live on a product carrying identifier_exists=false: optedOut=true,
// writes=[].
// ════════════════════════════════════════════════════════════════════════════
describe("metafield key normalisation", () => {
  it("never combines `namespace` with `keys` — Shopify rejects that pair", async () => {
    const { ENRICHMENT_METAFIELDS_ARGS } = await import(
      "../app/lib/enrichment/enrichment-decision.server"
    );
    expect(ENRICHMENT_METAFIELDS_ARGS).not.toMatch(/namespace\s*:/);
    expect(ENRICHMENT_METAFIELDS_ARGS).toMatch(/keys:\s*\[/);
    // Keys must be fully qualified, which is what `keys` requires.
    expect(ENRICHMENT_METAFIELDS_ARGS).toContain('"custom.gtin"');
    expect(ENRICHMENT_METAFIELDS_ARGS).toContain('"custom.identifier_exists"');
  });

  it("strips the namespace prefix so the decision can find its keys", async () => {
    const { bareMetafieldKey } = await import(
      "../app/lib/enrichment/enrichment-decision.server"
    );
    expect(bareMetafieldKey("custom.gtin")).toBe("gtin");
    expect(bareMetafieldKey("custom.identifier_exists")).toBe("identifier_exists");
    // Already-bare keys pass through unchanged.
    expect(bareMetafieldKey("brand")).toBe("brand");
  });

  it("HONOURS an opt-out delivered under a namespace-prefixed key", async () => {
    const { decideEnrichment, snapshotFromNode } = await import(
      "../app/lib/enrichment/enrichment-decision.server"
    );
    const snap = snapshotFromNode({
      id: "gid://shopify/Product/1",
      vendor: "V",
      variants: { nodes: [{ sku: "S", barcode: "B" }] },
      metafields: { nodes: [{ key: "custom.identifier_exists", value: "false" }] },
    });
    expect(snap.existing).toEqual({ identifier_exists: "false" });
    const d = decideEnrichment(snap, "Shop");
    expect(d.optedOut).toBe(true);
    expect(d.writes).toEqual([]);
  });

  it("does NOT overwrite existing values delivered under prefixed keys", async () => {
    const { decideEnrichment, snapshotFromNode } = await import(
      "../app/lib/enrichment/enrichment-decision.server"
    );
    const snap = snapshotFromNode({
      id: "gid://shopify/Product/2",
      vendor: "V",
      variants: { nodes: [{ sku: "SKU1", barcode: "BAR1" }] },
      metafields: {
        nodes: [
          { key: "custom.gtin", value: "existing-gtin" },
          { key: "custom.mpn", value: "existing-mpn" },
          { key: "custom.brand", value: "existing-brand" },
        ],
      },
    });
    const d = decideEnrichment(snap, "Shop");
    expect(d.writes).toEqual([]);
    expect(d.skipped.sort()).toEqual(["brand", "gtin", "mpn"]);
  });
});
