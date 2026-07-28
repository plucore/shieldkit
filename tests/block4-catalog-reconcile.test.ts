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
      // Must exist: the paginated queue read chains .range(), and a missing
      // method here would throw, silently exercising the enqueue-suppressed path
      // instead of the behaviour under test.
      range: () => c,
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
  it("does NOT let a schema_enrichments anchor veto live Shopify state", async () => {
    // The 2026-07-28 lesson. A throttled burst wrote ~4,000 anchors, ~628 of
    // which claimed success for products whose metafields were never written. An
    // anchor-based dedup here would classify exactly those as dedup_fresh and
    // refuse to re-enqueue the work the anchor was wrong about. The catalog page
    // is ground truth; a cache that can override it is worse than no cache.
    pages = [{ nodes: [product("1"), product("2")], hasNextPage: false, endCursor: null }];
    freshEnrichedIds = ["1", "2"]; // both "recently enriched" — and both wrong
    const r = await reconcileCatalog(opts({ mode: "enqueue" }));
    expect(r.skippedDedupFresh).toBe(0);
    expect(r.needsWork.map((p) => p.numericProductId)).toEqual(["1", "2"]);
    expect(insertedRows).toHaveLength(2);
  });

  it("never reads schema_enrichments at all", () => {
    const src = read("app", "lib", "enrichment", "catalog-reconcile.server.ts");
    expect(src).not.toMatch(/from\("schema_enrichments"\)/);
    // The prohibition must be documented where someone would re-add it.
    expect(src).toMatch(/NO schema_enrichments DEDUP/);
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

  it("never starts a merchant it cannot finish, and says which it skipped", () => {
    // The first production run hit 57.7s of the 60s ceiling with three merchants.
    // A merchant silently omitted from the results would read as "nothing to do".
    expect(src).toMatch(/ROUTE_BUDGET_MS/);
    expect(src).toMatch(/not_reached/);
    expect(src).toMatch(/notReached\.push\(m\.shopify_domain\)/);
  });

  it("a truncated walk can never report a passing verdict", () => {
    // Same defect class as Block 1: products the walk never read are
    // indistinguishable from products it decided need nothing.
    expect(src).toMatch(/inconclusive_truncated_walk/);
    expect(src).toMatch(/opts\.truncated\s*\n?\s*\?\s*"inconclusive_truncated_walk"/);
    expect(src).toMatch(/fail_unexplained_gap/);
  });

  it("raises the per-shop budget for a single-shop call", () => {
    // How a large catalog gets a complete one-pass walk instead of truncating.
    expect(src).toMatch(/SINGLE_SHOP_BUDGET_MS/);
    expect(src).toMatch(/onlyShop \? SINGLE_SHOP_BUDGET_MS : MULTI_SHOP_BUDGET_MS/);
  });

  it("paginates the webhook log read — PostgREST silently caps at 1,000", () => {
    // Measured: the first 7-day run read 777 distinct products from a window
    // holding 4,250 rows / 2,941 distinct. An under-read makes the gate look
    // CLEANER than it is, because a webhook-only product beyond the cap is never
    // considered for webhook_only_unexplained.
    expect(src).toMatch(/\.range\(offset, offset \+ PAGE - 1\)/);
    expect(src).toMatch(/rows\.length < PAGE/);
    expect(src).toMatch(/webhook_log_rows_read/);
  });

  it("a capped or errored log read cannot report a passing verdict either", () => {
    expect(src).toMatch(/inconclusive_webhook_log_read_incomplete/);
    expect(src).toMatch(/logReadTruncated \|\| logReadError/);
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

describe("drainer operator knobs (Block 4 burn-down)", () => {
  const src = read("app", "routes", "api.cron.process-scan-triggers.ts");

  it("defaults are unchanged, so the scheduled cadence keeps its CPU profile", () => {
    expect(src).toMatch(/const BATCH_SIZE = 150/);
    expect(src).toMatch(/const ENRICH_CONCURRENCY = 5/);
    expect(src).toMatch(/clamp\(params\.get\("batch"\), BATCH_SIZE, 1, 1000\)/);
    expect(src).toMatch(/clamp\(params\.get\("concurrency"\), ENRICH_CONCURRENCY, 1, 24\)/);
  });

  it("batch is capped at 1000 — PostgREST silently caps the response there", () => {
    // A larger .limit() would quietly select fewer rows than asked for, so the
    // run would under-report what it left behind.
    expect(src).toMatch(/PostgREST silently caps a\s*\n?\s*\*? ?response at 1000 rows/);
    expect(src).toMatch(/\.limit\(batchSize\)/);
  });

  it("a malformed or absent param falls back to the scheduled default", () => {
    // Number("") is 0 and Number("abc") is NaN; neither may become the batch size.
    expect(src).toMatch(/Number\.isFinite\(n\) && n >= min \? Math\.min\(Math\.floor\(n\), max\) : dflt/);
  });

  it("echoes the settings actually used, not the ones requested", () => {
    expect(src).toMatch(/batch_size: batchSize/);
    expect(src).toMatch(/budget_ms: timeBudgetMs/);
  });

  it("the overrides drive the real loop, not just the response", () => {
    expect(src).toMatch(/Date\.now\(\) - startedAt > timeBudgetMs/);
    expect(src).toMatch(/Math\.min\(concurrency, enrichmentRows\.length\)/);
  });
});

describe("the pending-queue read is paginated — the third 1,000-row cap in one day", () => {
  const src = read("app", "lib", "enrichment", "catalog-reconcile.server.ts");
  const route = read("app", "routes", "api.cron.reconcile-catalog.ts");

  it("paginates alreadyQueued with .range()", () => {
    // Measured: an unbounded read of a ~4,000-row pending queue saw only the
    // first 1,000, so four passes during a deploy window inflated the queue from
    // ~4,700 to 15,559 rows — every duplicate a full Admin API round trip that
    // finds nothing to do.
    const idx = src.indexOf("const alreadyQueued");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 1600);
    expect(block).toMatch(/\.range\(offset, offset \+ PAGE - 1\)/);
    expect(block).toMatch(/rows\.length < PAGE/);
  });

  it("refuses to enqueue when it could not read the whole queue", () => {
    // An incomplete view can only cause duplicates. Reporting stays accurate;
    // only the write is suppressed.
    expect(src).toMatch(/queuedReadComplete/);
    expect(src).toMatch(/const mayEnqueue = opts\.mode === "enqueue" && queuedReadComplete/);
    expect(src).toMatch(/enqueue_suppressed/);
    expect(src).toMatch(/if \(mayEnqueue && !alreadyQueued\.has\(pid\)\)/);
  });

  it("the size hint counts instead of pulling rows", () => {
    expect(route).toMatch(/count: "exact", head: true/);
    expect(route).not.toMatch(/\.from\("schema_enrichments"\)\s*\n?\s*\.select\("merchant_id"\)/);
  });
});

describe("cursor persistence — coverage, not just latency", () => {
  const route = read("app", "routes", "api.cron.reconcile-catalog.ts");
  const migration = read(
    "supabase", "migrations", "20260729000000_catalog_reconcile_state.sql",
  );

  it("resumes from the saved cursor instead of restarting at page 1", () => {
    // Load-bearing, not an optimisation. On the scheduled multi-shop run each
    // shop gets ~22s while sex-eshop's 31 pages need ~45s, so a walk that always
    // restarted would read the first ~15 pages FOREVER and never reach the tail —
    // not late, never, and invisible because every run looks successful.
    expect(route).toMatch(/loadState\(m\.shopify_domain\)/);
    expect(route).toMatch(/const resumeFrom =/);
    expect(route).toMatch(/after: resumeFrom/);
  });

  it("an explicit ?after= beats the saved cursor, and reset_cursor forces a restart", () => {
    expect(route).toMatch(/\(onlyShop && after\) \|\|/);
    expect(route).toMatch(/reset_cursor/);
    expect(route).toMatch(/resetCursor \|\| cycleStale \? null :/);
  });

  it("a cycle that never finishes is restarted rather than resumed forever", () => {
    expect(route).toMatch(/CYCLE_STALE_AFTER_MS/);
    expect(route).toMatch(/cycleStale/);
  });

  it("only a walk that reached the END closes the cycle", () => {
    expect(route).toMatch(
      /const cycleComplete = !rec\.truncated && rec\.nextCursor === null && rec\.errors\.length === 0/,
    );
  });

  it("the parity verdict grades COVERAGE, not per-invocation truncation", () => {
    // Truncation is normal once the walk resumes, so grading on it would mark
    // every large shop inconclusive forever. Cycle completion is the real question.
    expect(route).toMatch(/truncated: !cycleComplete/);
  });

  it("reports when the whole catalog was last seen", () => {
    expect(route).toMatch(/last_full_catalog_pass: nextState\.last_completed_at/);
    expect(route).toMatch(/cycle_complete: cycleComplete/);
  });

  it("a failed state read or write can never skip catalog", () => {
    // Losing the cursor costs a repeated walk; that is the safe direction.
    expect(route).toMatch(/start from the beginning/);
    expect(route).toMatch(/never skipped catalog/);
  });

  it("the state table is FK-free, keyed on shop_domain, and holds no PII", () => {
    const createStart = migration.indexOf("CREATE TABLE IF NOT EXISTS catalog_reconcile_state");
    const ddl = migration
      .slice(createStart, migration.indexOf("\n);", createStart))
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    expect(ddl).toMatch(/shop_domain\s+TEXT PRIMARY KEY/);
    expect(ddl).not.toMatch(/REFERENCES/i);
    expect(ddl).not.toMatch(/merchant_id/);
    for (const col of ["email", "owner", "address", "token"]) {
      expect(ddl).not.toMatch(new RegExp(col, "i"));
    }
  });
});

describe("the products/UPDATE switch is durable, not a one-off deletion", () => {
  const src = read("app", "lib", "webhooks", "product-webhooks.server.ts");

  it("separates topics we MANAGE from topics we WANT", () => {
    expect(src).toMatch(/const MANAGED_TOPICS = \["PRODUCTS_CREATE", "PRODUCTS_UPDATE"\] as const/);
    expect(src).toMatch(/const DESIRED_TOPICS = \["PRODUCTS_CREATE"\] as const/);
  });

  it("ensureProductWebhooks CONVERGES — it tears down a managed topic no longer wanted", () => {
    // Without this, deleting the subscription by hand would be undone by the next
    // ensureProductWebhooks call (afterAuth, billing confirm, or the daily cron at
    // 04:00 UTC) and the revert would be SILENT.
    const idx = src.indexOf("Converge DOWN first");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 1200);
    expect(block).toMatch(/for \(const topic of MANAGED_TOPICS\)/);
    expect(block).toMatch(/DESIRED_TOPICS as readonly string\[\]\)\.includes\(topic\)\) continue/);
    expect(block).toMatch(/DELETE_MUTATION/);
    expect(block).toMatch(/result\.removed\.push\(topic\)/);
    // ...and it must run BEFORE the create loop, or a create could race the delete.
    expect(idx).toBeLessThan(src.indexOf("for (const topic of DESIRED_TOPICS)"));
  });

  it("creates only DESIRED topics", () => {
    expect(src).toMatch(/for \(const topic of DESIRED_TOPICS\) \{/);
    expect(src).not.toMatch(/for \(const topic of PRODUCT_TOPICS\)/);
  });

  it("still LISTS both topics, or it could never see what to tear down", () => {
    const listIdx = src.indexOf("const LIST_QUERY");
    expect(src.slice(listIdx, listIdx + 400)).toMatch(/PRODUCTS_CREATE, PRODUCTS_UPDATE/);
  });

  it("removeProductWebhooks can be scoped to specific topics", () => {
    expect(src).toMatch(/topics\?: readonly string\[\]/);
    expect(src).toMatch(/\(!topics \|\| topics\.includes\(n\.topic\)\)/);
  });

  it("PRODUCTS_CREATE is kept, and the reason is recorded", () => {
    // A brand-new product is the one case where the reconcile's cycle latency is
    // visible to a merchant, and it carries no write-echo.
    expect(src).toMatch(/PRODUCTS_CREATE is DELIBERATELY KEPT/);
    expect(src).toMatch(/8,173/); // the echo measurement that decided it
  });
});

describe("entitlement provisioning lands with the entitlement", () => {
  it("the app_subscriptions/update ACTIVE branch provisions", () => {
    const src = read("app", "routes", "webhooks.app_subscriptions.update.tsx");
    expect(src).toMatch(/ensureProductWebhooks\(shop\)/);
    // Awaited, not `void` — a serverless container can freeze on response and
    // silently drop a floating promise.
    expect(src).toMatch(/const ensure = await ensureProductWebhooks\(shop\)/);
  });

  it("dashboard selfHealBilling provisions on drift", () => {
    const src = read("app", "routes", "app._index.tsx");
    expect(src).toMatch(/const ensure = await ensureProductWebhooks\(shopDomain\)/);
  });

  it("the unreconcilable-entitlement alarm exists and exempts the dev store by name", () => {
    // tier != 'free' AND shopify_subscription_id IS NULL is invisible to every
    // reconciler. The dev store lives there legitimately and forever (test-only
    // charges), and alarming on it daily would train the alarm to be ignored.
    const src = read("app", "routes", "api.cron.reconcile-subscriptions.ts");
    expect(src).toMatch(/PROVISIONING_ALARM_EXEMPT/);
    expect(src).toMatch(/shieldkit-test-stor\.myshopify\.com/);
    expect(src).toMatch(/\.is\("shopify_subscription_id", null\)\s*\n?\s*\.neq\("tier", "free"\)/);
    expect(src).toMatch(/unreconcilable_paid: unreconcilablePaid/);
    expect(src).toMatch(/unreconcilable_exempt: unreconcilableExempt/);
    // Alarms only on the non-exempt set.
    expect(src).toMatch(/if \(unreconcilablePaid\.length > 0\)/);
  });
});
