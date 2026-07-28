/**
 * tests/block4-catalog-reconcile.test.ts
 *
 * The catalog reconcile replaces products/* as the enrichment DISCOVERY
 * mechanism. Dropping the webhooks before this is proven silently stops
 * enrichment on edits to existing products — which is what the one paying
 * merchant with a large catalog is buying — so these tests are biased toward
 * catching a MISSED product, not a redundant one.
 *
 * Two properties carry the whole design:
 *
 *   1. Both paths run the SAME decision function. If the per-product enricher
 *      ever re-implements the rules, the parity gate stops testing discovery and
 *      starts accidentally testing two implementations against each other. The
 *      2026-07 scan incident was exactly this failure (three drifted copies of
 *      the same detectors fabricating criticals).
 *
 *   2. A failed page is never read as "the catalog ends here". That is the same
 *      root defect as Block 1: a fetch failure converted into a factual
 *      negative. Here it would silently under-report the catalog and, in enqueue
 *      mode, silently skip every product after the failure.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");

// ─── Fixtures the mocks read ────────────────────────────────────────────────
type Node = {
  id: string;
  vendor: string | null;
  updatedAt: string;
  variants: { nodes: Array<{ sku: string | null; barcode: string | null }> } | null;
  metafields: { nodes: Array<{ key: string; value: string }> } | null;
};
let pages: Array<{ nodes: Node[]; hasNextPage: boolean; endCursor: string | null }> = [];
let pageFailsAt: number | null = null;
let shopNameThrows = false;
let freshEnrichedIds: string[] = [];
let queuedIds: string[] = [];
let insertedRows: Array<Record<string, unknown>> = [];
let insertFails = false;
let pageCalls: Array<string | null> = [];

vi.mock("../app/supabase.server", () => {
  const chain = (table: string) => {
    const ctx: { table: string } = { table };
    const c: Record<string, (...a: any[]) => any> = {
      select: () => c,
      eq: () => c,
      gte: () => c,
      is: () => c,
      in: () => c,
      not: () => c,
      order: () => c,
      limit: () => c,
      insert: async (rows: Record<string, unknown>[]) => {
        if (insertFails) return { error: { message: "insert boom" } };
        insertedRows.push(...(Array.isArray(rows) ? rows : [rows]));
        return { error: null };
      },
      then: (resolve: (v: unknown) => unknown) => {
        if (ctx.table === "schema_enrichments") {
          return Promise.resolve(
            resolve({ data: freshEnrichedIds.map((product_id) => ({ product_id })), error: null }),
          );
        }
        if (ctx.table === "pending_scan_triggers") {
          return Promise.resolve(
            resolve({
              data: queuedIds.map((id) => ({ payload: { numeric_product_id: id } })),
              error: null,
            }),
          );
        }
        return Promise.resolve(resolve({ data: [], error: null }));
      },
    };
    return c;
  };
  return { supabase: { from: (t: string) => chain(t) } };
});

vi.mock("../app/lib/shopify-api.server", () => ({
  createAdminClient: async () => {
    return async (query: string, variables?: Record<string, unknown>) => {
      if (query.includes("ReconcileShopName")) {
        if (shopNameThrows) throw new Error("shop name unavailable");
        return { data: { shop: { name: "Fallback Shop" } } };
      }
      const after = (variables?.after as string | null) ?? null;
      pageCalls.push(after);
      const index = after === null ? 0 : pages.findIndex((p) => p.endCursor === after) + 1;
      if (pageFailsAt !== null && index === pageFailsAt) {
        throw new Error("HTTP 503 from shop");
      }
      const p = pages[index];
      if (!p) return { data: { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } };
      return {
        data: {
          products: {
            pageInfo: { hasNextPage: p.hasNextPage, endCursor: p.endCursor },
            nodes: p.nodes,
          },
        },
        extensions: { cost: { actualQueryCost: 79 } },
      };
    };
  },
}));

const { reconcileCatalog, PAGE_SIZE } = await import(
  "../app/lib/enrichment/catalog-reconcile.server"
);
const { decideEnrichment, needsShopNameFallback, snapshotFromNode } = await import(
  "../app/lib/enrichment/enrichment-decision.server"
);

const product = (
  id: string,
  o: Partial<{ vendor: string | null; sku: string | null; barcode: string | null; mf: Record<string, string> }> = {},
): Node => ({
  id: `gid://shopify/Product/${id}`,
  vendor: o.vendor === undefined ? "Acme" : o.vendor,
  updatedAt: "2026-07-28T00:00:00Z",
  // `??` would swallow an explicit null, silently giving every product a SKU and
  // barcode — which would make the no_signal cases untestable.
  variants: {
    nodes: [
      {
        sku: "sku" in o ? (o.sku ?? null) : "SKU-1",
        barcode: "barcode" in o ? (o.barcode ?? null) : "0123456789012",
      },
    ],
  },
  metafields: { nodes: Object.entries(o.mf ?? {}).map(([key, value]) => ({ key, value })) },
});

const opts = (extra: Record<string, unknown> = {}) => ({
  shopDomain: "s.myshopify.com",
  merchantId: "m-1",
  mode: "observe" as const,
  ...extra,
});

beforeEach(() => {
  pages = [];
  pageFailsAt = null;
  shopNameThrows = false;
  freshEnrichedIds = [];
  queuedIds = [];
  insertedRows = [];
  insertFails = false;
  pageCalls = [];
});

// ────────────────────────────────────────────────────────────────────────────
describe("the decision function is shared, not duplicated", () => {
  it("the per-product enricher imports it and keeps no rules of its own", () => {
    const src = read("app", "lib", "enrichment", "gtin-enrichment.server.ts");
    expect(src).toMatch(/from "\.\/enrichment-decision\.server"/);
    expect(src).toMatch(/decideEnrichment\(snap, shopName\)/);
    // The old inline rules must be gone, or the two paths can drift again.
    expect(src).not.toMatch(/identifier_exists"\] === "false"/);
    expect(src).not.toMatch(/skipped\.push\("gtin"\)/);
  });

  it("the reconcile imports the same function", () => {
    const src = read("app", "lib", "enrichment", "catalog-reconcile.server.ts");
    expect(src).toMatch(/decideEnrichment/);
    expect(src).toMatch(/from "\.\/enrichment-decision\.server"/);
  });

  it("decides identically for the same snapshot regardless of caller", () => {
    const snap = snapshotFromNode(product("1", { mf: { gtin: "999" } }));
    const d = decideEnrichment(snap, "Shop");
    expect(d.writes.map((w) => w.key)).toEqual(["mpn", "brand"]);
    expect(d.skipped).toEqual(["gtin"]);
  });

  it("honours the identifier_exists opt-out", () => {
    const d = decideEnrichment(snapshotFromNode(product("1", { mf: { identifier_exists: "false" } })), "Shop");
    expect(d.optedOut).toBe(true);
    expect(d.writes).toEqual([]);
    expect(d.skipped).toEqual(["gtin", "mpn", "brand"]);
  });

  it("brand falls back vendor -> shop name, and reports no_signal with neither", () => {
    expect(decideEnrichment(snapshotFromNode(product("1", { vendor: "Acme" })), "Shop").writes)
      .toEqual(expect.arrayContaining([{ key: "brand", value: "Acme" }]));
    expect(decideEnrichment(snapshotFromNode(product("1", { vendor: null })), "Shop").writes)
      .toEqual(expect.arrayContaining([{ key: "brand", value: "Shop" }]));
    const none = decideEnrichment(snapshotFromNode(product("1", { vendor: null })), null);
    expect(none.writes.map((w) => w.key)).not.toContain("brand");
  });

  it("needsShopNameFallback is true only when it would change the outcome", () => {
    expect(needsShopNameFallback(snapshotFromNode(product("1", { vendor: null })))).toBe(true);
    expect(needsShopNameFallback(snapshotFromNode(product("1", { vendor: "Acme" })))).toBe(false);
    expect(needsShopNameFallback(snapshotFromNode(product("1", { vendor: null, mf: { brand: "B" } })))).toBe(false);
    expect(
      needsShopNameFallback(snapshotFromNode(product("1", { vendor: null, mf: { identifier_exists: "false" } }))),
    ).toBe(false);
  });

  it("reads only the FIRST variant, matching variants(first: 1)", () => {
    const n = product("1", { mf: {} });
    n.variants = { nodes: [{ sku: "FIRST", barcode: "B1" }, { sku: "SECOND", barcode: "B2" }] };
    const snap = snapshotFromNode(n);
    expect(snap.sku).toBe("FIRST");
    expect(snap.barcode).toBe("B1");
  });
});

describe("paging", () => {
  it("uses first: 250 — measured feasible, not assumed", () => {
    expect(PAGE_SIZE).toBe(250);
    const src = read("app", "lib", "enrichment", "catalog-reconcile.server.ts");
    // The header must carry the live cost measurement that justifies 250, so a
    // future reader does not "fix" it down on a guess about cost limits.
    expect(src).toMatch(/actualQueryCost 79/);
    expect(src).toMatch(/7,685 products/);
  });

  it("follows the cursor across pages and decides without any per-product call", async () => {
    pages = [
      { nodes: [product("1"), product("2")], hasNextPage: true, endCursor: "c1" },
      { nodes: [product("3")], hasNextPage: false, endCursor: null },
    ];
    const r = await reconcileCatalog(opts());
    expect(r.pagesWalked).toBe(2);
    expect(r.productsSeen).toBe(3);
    expect(pageCalls).toEqual([null, "c1"]); // exactly 2 catalog reads for 3 products
    expect(r.needsWork).toHaveLength(3);
    expect(r.truncated).toBe(false);
    expect(r.nextCursor).toBeNull();
  });

  it("accumulates the measured query cost", async () => {
    pages = [{ nodes: [product("1")], hasNextPage: false, endCursor: null }];
    const r = await reconcileCatalog(opts());
    expect(r.totalActualQueryCost).toBe(79);
  });

  it("resumes from a supplied cursor", async () => {
    pages = [
      { nodes: [product("1")], hasNextPage: true, endCursor: "c1" },
      { nodes: [product("2")], hasNextPage: false, endCursor: null },
    ];
    const r = await reconcileCatalog(opts({ after: "c1" }));
    expect(r.productsSeen).toBe(1);
    expect(r.needsWork[0].numericProductId).toBe("2");
  });
});

describe("a failed page is never 'the catalog ends here'", () => {
  it("marks truncated, keeps the cursor, and reports the error", async () => {
    pages = [
      { nodes: [product("1")], hasNextPage: true, endCursor: "c1" },
      { nodes: [product("2")], hasNextPage: true, endCursor: "c2" },
      { nodes: [product("3")], hasNextPage: false, endCursor: null },
    ];
    pageFailsAt = 1; // second page 503s
    const r = await reconcileCatalog(opts());
    expect(r.pagesWalked).toBe(1);
    expect(r.truncated).toBe(true);
    expect(r.nextCursor).toBe("c1"); // resume point, not a restart
    expect(r.errors.join(" ")).toMatch(/503/);
    // Crucially: products 2 and 3 are absent rather than reported as needing
    // nothing, so no caller can read them as complete.
    expect(r.needsWork.map((p) => p.numericProductId)).toEqual(["1"]);
    expect(r.noWork).toHaveLength(0);
  });

  it("enqueues nothing beyond the failure point", async () => {
    pages = [
      { nodes: [product("1")], hasNextPage: true, endCursor: "c1" },
      { nodes: [product("2")], hasNextPage: false, endCursor: null },
    ];
    pageFailsAt = 1;
    const r = await reconcileCatalog(opts({ mode: "enqueue" }));
    expect(r.enqueued).toBe(1);
    expect(insertedRows.map((x) => (x.payload as any).numeric_product_id)).toEqual(["1"]);
  });

  it("a failed admin client returns an empty, clearly-errored result", async () => {
    const mod = await import("../app/lib/shopify-api.server");
    const spy = vi.spyOn(mod, "createAdminClient").mockRejectedValueOnce(new Error("HTTP 401"));
    const r = await reconcileCatalog(opts());
    expect(r.productsSeen).toBe(0);
    expect(r.errors.join(" ")).toMatch(/admin_client.*401/);
    spy.mockRestore();
  });

  it("a lost shop name degrades brand to no_signal, never to a wrong value", async () => {
    shopNameThrows = true;
    pages = [{ nodes: [product("1", { vendor: null, sku: null, barcode: null })], hasNextPage: false, endCursor: null }];
    const r = await reconcileCatalog(opts());
    expect(r.errors.join(" ")).toMatch(/shop_name/);
    expect(r.needsWork).toHaveLength(0);
    expect(r.noWork[0].reason).toBe("no_signal");
  });
});

describe("observe mode writes nothing", () => {
  it("inserts no rows even when every product needs work", async () => {
    pages = [{ nodes: [product("1"), product("2")], hasNextPage: false, endCursor: null }];
    const r = await reconcileCatalog(opts({ mode: "observe" }));
    expect(r.needsWork).toHaveLength(2);
    expect(r.enqueued).toBe(0);
    expect(insertedRows).toHaveLength(0);
  });
});

describe("enqueue mode matches the webhook path's dedup semantics", () => {
  it("skips products enriched inside the 24h window", async () => {
    pages = [{ nodes: [product("1"), product("2")], hasNextPage: false, endCursor: null }];
    freshEnrichedIds = ["1"];
    const r = await reconcileCatalog(opts({ mode: "enqueue" }));
    expect(r.skippedDedupFresh).toBe(1);
    expect(r.needsWork.map((p) => p.numericProductId)).toEqual(["2"]);
    expect(r.noWork.find((p) => p.numericProductId === "1")?.reason).toBe("dedup_fresh");
    expect(insertedRows).toHaveLength(1);
  });

  it("does not double-enqueue an already-queued product", async () => {
    pages = [{ nodes: [product("1"), product("2")], hasNextPage: false, endCursor: null }];
    queuedIds = ["1"];
    const r = await reconcileCatalog(opts({ mode: "enqueue" }));
    // Still reported as needing work — it does — but not re-queued.
    expect(r.needsWork).toHaveLength(2);
    expect(insertedRows.map((x) => (x.payload as any).numeric_product_id)).toEqual(["2"]);
  });

  it("does not enqueue the same product twice within one pass", async () => {
    pages = [
      { nodes: [product("1")], hasNextPage: true, endCursor: "c1" },
      { nodes: [product("1")], hasNextPage: false, endCursor: null },
    ];
    const r = await reconcileCatalog(opts({ mode: "enqueue" }));
    expect(r.enqueued).toBe(1);
  });

  it("honours enqueueCap so a first pass cannot bury the drainer", async () => {
    pages = [{ nodes: [product("1"), product("2"), product("3")], hasNextPage: false, endCursor: null }];
    const r = await reconcileCatalog(opts({ mode: "enqueue", enqueueCap: 2 }));
    expect(r.needsWork).toHaveLength(3); // reporting is uncapped
    expect(r.enqueued).toBe(2); // writing is capped
  });

  it("writes the payload shape the drainer already reads", async () => {
    pages = [{ nodes: [product("42")], hasNextPage: false, endCursor: null }];
    await reconcileCatalog(opts({ mode: "enqueue" }));
    expect(insertedRows[0]).toEqual({
      merchant_id: "m-1",
      trigger_type: "enrichment",
      payload: { product_gid: "gid://shopify/Product/42", numeric_product_id: "42" },
    });
  });

  it("reports an insert failure instead of claiming the enqueue succeeded", async () => {
    pages = [{ nodes: [product("1")], hasNextPage: false, endCursor: null }];
    insertFails = true;
    const r = await reconcileCatalog(opts({ mode: "enqueue" }));
    expect(r.enqueued).toBe(0);
    expect(r.errors.join(" ")).toMatch(/enqueue/);
  });
});

describe("classification of products with no work", () => {
  it("already_complete when all three keys are set", async () => {
    pages = [
      {
        nodes: [product("1", { mf: { gtin: "g", mpn: "m", brand: "b" } })],
        hasNextPage: false,
        endCursor: null,
      },
    ];
    const r = await reconcileCatalog(opts());
    expect(r.noWork[0].reason).toBe("already_complete");
  });

  it("no_signal when a key is missing but the source field is empty", async () => {
    pages = [
      {
        nodes: [product("1", { sku: null, barcode: null, mf: { brand: "b" } })],
        hasNextPage: false,
        endCursor: null,
      },
    ];
    const r = await reconcileCatalog(opts());
    expect(r.noWork[0].reason).toBe("no_signal");
  });

  it("opted_out is reported distinctly, not lumped in with complete", async () => {
    pages = [{ nodes: [product("1", { mf: { identifier_exists: "false" } })], hasNextPage: false, endCursor: null }];
    const r = await reconcileCatalog(opts());
    expect(r.noWork[0].reason).toBe("opted_out");
  });
});

describe("the cron route is gated and shaped correctly", () => {
  const src = read("app", "routes", "api.cron.reconcile-catalog.ts");

  it("serves BOTH verbs and authorises on the bearer secret, not the verb", () => {
    expect(src).toMatch(/export async function loader/);
    expect(src).toMatch(/export async function action/);
    expect(src).toMatch(/token !== cronSecret/);
    expect(src).not.toMatch(/405/);
  });

  it("defaults to observe — the parallel run must never write", () => {
    expect(src).toMatch(/mode = url\.searchParams\.get\("mode"\) === "enqueue" \? "enqueue" : "observe"/);
  });

  it("restricts to paid, still-installed merchants", () => {
    expect(src).toMatch(/PAID_TIERS/);
    expect(src).toMatch(/\.is\("uninstalled_at", null\)/);
  });

  it("forces observe when write_products is not granted", () => {
    // Enqueuing work the drainer cannot perform would be pure queue growth.
    expect(src).toMatch(/mode: scopeOk \? mode : "observe"/);
  });

  it("counts a webhook-seen product it cannot account for as unexplained", () => {
    // This is the number that blocks the switch. It must exist and be surfaced.
    expect(src).toMatch(/webhook_only_unexplained/);
    expect(src).toMatch(/not_in_walked_catalog/);
  });

  it("names the one real regression: event latency becomes cycle latency", () => {
    expect(src).toMatch(/event-latency/);
    expect(src).toMatch(/cycle-latency/);
  });
});

describe("removeProductWebhooks is NOT called from the reconcile path", () => {
  it("no reconcile file references it", () => {
    // The gate is explicit: the webhooks stay until the parity comparison is
    // reviewed and approved. A stray call here would remove them on the first
    // cron tick.
    for (const f of [
      ["app", "lib", "enrichment", "catalog-reconcile.server.ts"],
      ["app", "routes", "api.cron.reconcile-catalog.ts"],
    ]) {
      expect(read(...f)).not.toMatch(/removeProductWebhooks/);
    }
  });

  it("the products/* subscriptions are still ensured, not removed", () => {
    expect(read("app", "routes", "api.cron.reconcile-subscriptions.ts")).toMatch(
      /ensureProductWebhooks/,
    );
  });
});
