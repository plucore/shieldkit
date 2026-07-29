/**
 * BEHAVIOURAL coverage for cursor persistence — the mechanism that decides
 * whether a large catalog is ever fully seen.
 *
 * Before 2026-07-29 every assertion about it was a regex over the route's source
 * text, and neither loadState nor saveState was invoked by any test in the repo:
 * the block4 mock had no `upsert` and no catalog_reconcile_state branch, so the
 * round trip could not be exercised even by accident.
 *
 * This matters more than most coverage. Without a working cursor, a shop whose
 * catalog needs more than one invocation re-reads its first N pages FOREVER and
 * never reaches the tail — not late, never — and every individual run reports
 * success. That is the failure the cursor exists to prevent, so "the cursor
 * works" needs to be something we execute, not something we grep.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;

let merchantRows: Row[] = [];
let stateRow: Row | null = null;
let upserts: Row[] = [];
let upsertFails = false;
let sizeHintCount = 0;

vi.mock("../app/supabase.server", () => {
  const chain = (table: string) => {
    const c: Record<string, (...a: any[]) => any> = {
      select: (_cols?: string, opts?: { head?: boolean; count?: string }) => {
        if (opts?.head) {
          // schema_enrichments size hint — a count, never a row pull.
          return Object.assign(Promise.resolve({ count: sizeHintCount }), c);
        }
        return c;
      },
      eq: () => c,
      is: () => c,
      in: () => c,
      not: () => c,
      gte: () => c,
      order: () => c,
      limit: () => c,
      range: () => c,
      maybeSingle: async () =>
        table === "catalog_reconcile_state"
          ? { data: stateRow, error: null }
          : { data: null, error: null },
      upsert: async (row: Row) => {
        if (upsertFails) return { error: { message: "upsert boom" } };
        upserts.push(row);
        stateRow = row;
        return { error: null };
      },
      insert: async () => ({ error: null }),
      then: (resolve: (v: unknown) => unknown) => {
        if (table === "merchants") return resolve({ data: merchantRows, error: null });
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

// The walk itself is not under test here — the STATE MACHINE around it is.
let walkResult: Record<string, unknown> = {};
let observedAfter: Array<string | null> = [];

vi.mock("../app/lib/enrichment/catalog-reconcile.server", () => ({
  reconcileCatalog: vi.fn(async (o: { after?: string | null }) => {
    observedAfter.push(o.after ?? null);
    return {
      shopDomain: "s.myshopify.com",
      merchantId: "m-1",
      mode: "enqueue",
      pagesWalked: 5,
      productsSeen: 1250,
      needsWork: [],
      noWork: [],
      enqueued: 0,
      skippedDedupFresh: 0,
      truncated: false,
      nextCursor: null,
      elapsedMs: 100,
      totalActualQueryCost: 10,
      errors: [],
      ...walkResult,
    };
  }),
}));

const { loader } = await import("../app/routes/api.cron.reconcile-catalog");

const call = () =>
  loader({
    request: new Request("https://x/api/cron/reconcile-catalog", {
      headers: { Authorization: "Bearer test-secret" },
    }),
  } as unknown as Parameters<typeof loader>[0]);

beforeEach(() => {
  process.env.CRON_SECRET = "test-secret";
  process.env.SCOPES = "write_products";
  merchantRows = [
    { id: "m-1", shopify_domain: "s.myshopify.com", tier: "monitoring" },
  ];
  stateRow = null;
  upserts = [];
  upsertFails = false;
  sizeHintCount = 0;
  walkResult = {};
  observedAfter = [];
});

describe("cursor persistence — the round trip, executed", () => {
  it("a TRUNCATED walk saves its cursor and does NOT close the cycle", async () => {
    walkResult = { truncated: true, nextCursor: "CURSOR_PAGE_15" };
    const res = await call();
    const body = (await res.json()) as { results: Array<Record<string, unknown>> };

    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      shop_domain: "s.myshopify.com",
      cursor: "CURSOR_PAGE_15",
      last_completed_at: null,
    });
    expect(body.results[0].cycle_complete).toBe(false);
    expect(body.results[0].last_full_catalog_pass).toBeNull();
  });

  it("the NEXT run RESUMES from the saved cursor rather than restarting", async () => {
    // The whole point. Without this, a 31-page catalog re-reads its first ~15
    // pages forever while every run looks successful.
    walkResult = { truncated: true, nextCursor: "CURSOR_PAGE_15" };
    await call();
    expect(observedAfter[0]).toBeNull(); // first run starts fresh

    walkResult = { truncated: false, nextCursor: null };
    await call();
    expect(observedAfter[1]).toBe("CURSOR_PAGE_15"); // second run RESUMES
  });

  it("a COMPLETED walk clears the cursor and stamps last_completed_at", async () => {
    walkResult = { truncated: false, nextCursor: null };
    const res = await call();
    const body = (await res.json()) as { results: Array<Record<string, unknown>> };

    expect(upserts[0]).toMatchObject({ cursor: null });
    expect(upserts[0].last_completed_at).toEqual(expect.any(String));
    expect(body.results[0].cycle_complete).toBe(true);
    expect(body.results[0].last_full_catalog_pass).toEqual(expect.any(String));
  });

  it("cycle counters ACCUMULATE across a resumed cycle and reset on completion", async () => {
    walkResult = { truncated: true, nextCursor: "C1", pagesWalked: 15, productsSeen: 3750 };
    await call();
    expect(upserts[0]).toMatchObject({
      pages_walked_this_cycle: 15,
      products_seen_this_cycle: 3750,
    });

    walkResult = { truncated: true, nextCursor: "C2", pagesWalked: 10, productsSeen: 2500 };
    await call();
    expect(upserts[1]).toMatchObject({
      pages_walked_this_cycle: 25,
      products_seen_this_cycle: 6250,
    });

    walkResult = { truncated: false, nextCursor: null, pagesWalked: 6, productsSeen: 1435 };
    await call();
    expect(upserts[2]).toMatchObject({
      pages_walked_this_cycle: 0,
      products_seen_this_cycle: 0,
      cursor: null,
    });
  });

  it("a FAILED state write is reported, and does not claim a completed cycle", async () => {
    // saveState used to swallow the error and return the INTENDED state, so the
    // response advertised a cursor and a completion that never reached the DB
    // while the next run silently restarted from page 1.
    upsertFails = true;
    walkResult = { truncated: false, nextCursor: null };
    const res = await call();
    const body = (await res.json()) as {
      degraded: boolean;
      results: Array<Record<string, unknown>>;
    };

    expect(body.results[0].cursor_persisted).toBe(false);
    expect(body.results[0].cycle_complete).toBe(false);
    expect(body.results[0].last_full_catalog_pass).toBeNull();
    expect(String(body.results[0].errors)).toMatch(/cursor_not_persisted/);
    expect(body.degraded).toBe(true);
    expect(res.status).toBe(500);
  });

  it("a NON-FATAL walk error blocks cycle completion", async () => {
    // errors[] is part of the completion predicate on purpose: a walk that
    // could not resolve the shop name decided some products with missing data,
    // so it must not be recorded as "the whole catalog has been seen".
    walkResult = { truncated: false, nextCursor: null, errors: ["shop_name_unavailable: x"] };
    const res = await call();
    const body = (await res.json()) as { results: Array<Record<string, unknown>> };
    expect(body.results[0].cycle_complete).toBe(false);
    expect(body.results[0].last_full_catalog_pass).toBeNull();
  });
});

describe("not_reached is reported, never silently omitted", () => {
  it("reports not_reached explicitly, and a clean run leaves it empty", async () => {
    // A silently-omitted merchant reads as "nothing to do for that shop". The
    // field must always be present so its emptiness is an assertion rather than
    // an absence — `not_reached: []` means "we covered everyone", whereas a
    // missing key means nothing at all.
    merchantRows = [
      { id: "m-1", shopify_domain: "a.myshopify.com", tier: "monitoring" },
      { id: "m-2", shopify_domain: "b.myshopify.com", tier: "monitoring" },
    ];
    const res = await call();
    const body = (await res.json()) as {
      not_reached: string[];
      degraded: boolean;
      merchants: number;
      results: unknown[];
    };
    expect(body.merchants).toBe(2);
    expect(body.not_reached).toEqual([]);
    expect(body.results).toHaveLength(2);
    expect(body.degraded).toBe(false);
    expect(res.status).toBe(200);
  });

  it("a missing write_products scope degrades instead of silently observing", async () => {
    // scopeOk false forces mode to observe. The run then writes nothing while
    // returning 200 and reporting mode=enqueue at the top level — the exact
    // silent no-op the loud-failure change exists to surface.
    process.env.SCOPES = "read_products";
    const res = await call();
    const body = (await res.json()) as {
      degraded: boolean;
      degraded_reasons: string[];
      scope_ok: boolean;
    };
    expect(body.scope_ok).toBe(false);
    expect(body.degraded).toBe(true);
    expect(body.degraded_reasons.join(" ")).toMatch(/write_products/);
    expect(res.status).toBe(500);
  });
});
