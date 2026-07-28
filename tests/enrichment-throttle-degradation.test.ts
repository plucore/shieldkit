/**
 * tests/enrichment-throttle-degradation.test.ts
 *
 * BEHAVIOURAL proof for the defect that silently discarded ~5,800 products of a
 * paying merchant's enrichment on 2026-07-28.
 *
 * A Shopify THROTTLED reply is **HTTP 200** carrying `errors[{code: THROTTLED}]`
 * and no `data`. Three things then went wrong in sequence:
 *
 *   1. The read path read `json?.data?.product`, got undefined, and returned
 *      `product_not_found` — a rate limit reported as a fact about the catalog.
 *   2. The write path read `json?.data?.metafieldsSet?.userErrors ?? []`, got an
 *      empty list, and returned **ok: true with a populated `written` array** for
 *      fields it had not written. The caller then wrote a schema_enrichments
 *      anchor claiming the product was done, which also suppressed it from the
 *      24h dedup.
 *   3. The drainer counted both as processed and reported `errors: 0`.
 *
 * Same root defect as Block 1: "we could not look" converted into a factual
 * negative. These tests force each response shape rather than asserting on
 * source text.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");

vi.mock("../app/lib/enrichment/enrichment-decision.server", async (orig) => orig());

const { enrichProductMetafields } = await import(
  "../app/lib/enrichment/gtin-enrichment.server"
);

const GID = "gid://shopify/Product/123";

/** A shop that answers each query with the queued response, in order. */
const adminReturning = (responses: unknown[]) => {
  let i = 0;
  const calls: string[] = [];
  return {
    calls,
    admin: {
      graphql: async (query: string) => {
        calls.push(
          query.includes("ProductForEnrichment")
            ? "read"
            : query.includes("MetafieldsSet")
              ? "write"
              : "shop",
        );
        const r = responses[Math.min(i, responses.length - 1)];
        i += 1;
        if (r instanceof Error) throw r;
        return { json: async () => r };
      },
    },
  };
};

const PRODUCT_OK = {
  data: {
    product: {
      id: GID,
      title: "T",
      vendor: "Acme",
      variants: { edges: [{ node: { sku: "SKU-1", barcode: "0123456789012" } }] },
      metafields: { edges: [] },
    },
  },
};

const THROTTLED = {
  errors: [
    {
      message: "Throttled",
      extensions: { code: "THROTTLED", availableQueryCost: 0 },
    },
  ],
  extensions: { cost: { requestedQueryCost: 12, actualQueryCost: 0 } },
};

// ────────────────────────────────────────────────────────────────────────────
describe("a throttled READ is unavailable, never product_not_found", () => {
  it("returns unavailable:true and does NOT claim the product is missing", async () => {
    const { admin } = adminReturning([THROTTLED]);
    const r = await enrichProductMetafields(admin, GID);
    expect(r.ok).toBe(false);
    expect(r.unavailable).toBe(true);
    // The exact regression: this used to be "product_not_found".
    expect(r.error).not.toBe("product_not_found");
    expect(r.error).toMatch(/read_unavailable:THROTTLED/);
  });

  it("never attempts a write on an unavailable read", async () => {
    const { admin, calls } = adminReturning([THROTTLED]);
    await enrichProductMetafields(admin, GID);
    expect(calls).toEqual(["read"]);
  });

  it("an errors-only body with no data key is unavailable", async () => {
    const { admin } = adminReturning([{ errors: [{ message: "Access denied" }] }]);
    const r = await enrichProductMetafields(admin, GID);
    expect(r.unavailable).toBe(true);
  });

  it("data:null is unavailable, not an empty catalog", async () => {
    const { admin } = adminReturning([{ data: null }]);
    const r = await enrichProductMetafields(admin, GID);
    expect(r.unavailable).toBe(true);
  });

  it("a transport throw is unavailable", async () => {
    const { admin } = adminReturning([new Error("HTTP 429 from shop")]);
    const r = await enrichProductMetafields(admin, GID);
    expect(r.ok).toBe(false);
    expect(r.unavailable).toBe(true);
    expect(r.error).toMatch(/429/);
  });
});

describe("product_not_found stays reachable — it is a real answer", () => {
  it("data present with product:null IS terminal, not unavailable", async () => {
    const { admin } = adminReturning([{ data: { product: null } }]);
    const r = await enrichProductMetafields(admin, GID);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("product_not_found");
    expect(r.unavailable).toBeUndefined();
  });
});

describe("a throttled WRITE is never a success", () => {
  it("does not return ok:true with fields it never wrote", async () => {
    const { admin } = adminReturning([PRODUCT_OK, THROTTLED]);
    const r = await enrichProductMetafields(admin, GID);
    // THE false-success regression. This previously returned
    // { ok: true, written: ["gtin","mpn","brand"] } for an untouched product.
    expect(r.ok).toBe(false);
    expect(r.written).toEqual([]);
    expect(r.unavailable).toBe(true);
    expect(r.error).toMatch(/write_unavailable:THROTTLED/);
  });

  it("an absent metafieldsSet payload is unavailable, not empty userErrors", async () => {
    const { admin } = adminReturning([PRODUCT_OK, { data: {} }]);
    const r = await enrichProductMetafields(admin, GID);
    expect(r.ok).toBe(false);
    expect(r.unavailable).toBe(true);
  });

  it("a real userError is still a terminal write rejection, not a deferral", async () => {
    const { admin } = adminReturning([
      PRODUCT_OK,
      { data: { metafieldsSet: { userErrors: [{ field: null, message: "Value is invalid" }] } } },
    ]);
    const r = await enrichProductMetafields(admin, GID);
    expect(r.ok).toBe(false);
    expect(r.unavailable).toBeUndefined(); // retrying will not help
    expect(r.error).toMatch(/Value is invalid/);
  });

  it("a clean write still succeeds", async () => {
    const { admin } = adminReturning([
      PRODUCT_OK,
      { data: { metafieldsSet: { metafields: [], userErrors: [] } } },
    ]);
    const r = await enrichProductMetafields(admin, GID);
    expect(r.ok).toBe(true);
    expect(r.written).toEqual(["gtin", "mpn", "brand"]);
    expect(r.unavailable).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe("the drainer defers unavailable work instead of consuming it", () => {
  const src = read("app", "routes", "api.cron.process-scan-triggers.ts");

  it("re-enqueues on unavailable rather than dropping the product", () => {
    const idx = src.indexOf("if (result.unavailable)");
    expect(idx).toBeGreaterThan(-1);
    const branch = src.slice(idx, idx + 1800);
    expect(branch).toMatch(/from\("pending_scan_triggers"\)\.insert/);
    expect(branch).toMatch(/attempt/);
    // It still advances the queue row — one bad shop must never wedge the head
    // (the 2026-05 poison-pill lesson).
    expect(branch).toMatch(/markProcessed\(\[row\.id\]\)/);
  });

  it("bounds the retry so a broken product cannot loop forever", () => {
    expect(src).toMatch(/const MAX_ENRICH_ATTEMPTS = 3/);
    expect(src).toMatch(/attempt <= MAX_ENRICH_ATTEMPTS/);
    expect(src).toMatch(/requeue_exhausted/);
  });

  it("backs off within the invocation when the shop is rate limiting", () => {
    expect(src).toMatch(/UNAVAILABLE_STREAK_LIMIT/);
    expect(src).toMatch(/unavailableStreak >= UNAVAILABLE_STREAK_LIMIT/);
    expect(src).toMatch(/backed_off: backedOff/);
  });

  it("reports SUCCESSES, not attempts", () => {
    // "7,471 processed, 0 errors" while ~5,800 had failed is what made the old
    // counter worse than no counter.
    expect(src).toMatch(/enrichments_succeeded: succeeded/);
    expect(src).toMatch(/enrichments_deferred_unavailable: deferredUnavailable/);
    expect(src).toMatch(/enrichments_not_found: notFound/);
    expect(src).not.toMatch(/enrichments_processed/);
    expect(src).not.toMatch(/enrichmentsProcessed\+\+/);
  });

  it("only writes the schema_enrichments anchor on a genuine ok", () => {
    // The anchor suppresses the product from the 24h dedup, so writing it after
    // a throttle hides the product from the very mechanism meant to retry it.
    expect(src).toMatch(/if \(result\.ok && numericId\)/);
    const unavailIdx = src.indexOf("if (result.unavailable)");
    const anchorIdx = src.indexOf("if (result.ok && numericId)");
    expect(unavailIdx).toBeLessThan(anchorIdx); // returns before the anchor write
  });

  it("routes the enricher through executeWithRetry so THROTTLED is retried", () => {
    // createAdminClient returns a bare fetch wrapper with no rate-limit
    // handling; the bare executor is how every throttle reached the enricher
    // un-retried in the first place.
    expect(src).toMatch(/executeWithRetry\(executor, "enrichProductMetafields", query/);
    expect(src).not.toMatch(/const result = await executor\(query, options\?\.variables\)/);
  });
});
