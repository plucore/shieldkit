/**
 * tests/shop-redact.test.ts
 *
 * Coverage for the GDPR shop/redact webhook handler
 * (app/routes/webhooks.shop.redact.tsx).
 *
 * The handler must be resilient + idempotent because Shopify does NOT retry
 * redact on a non-2xx response — any throw is a permanent, silent compliance
 * gap. Verifies:
 *   - redact for a NON-existent merchant → 200, no throw, no Sentry.
 *   - redact for an existing merchant → deletes by shop domain (cascade) + 200.
 *   - a delete failure (Postgres error OR client-level rejection) → STILL 200,
 *     captured to Sentry with the shop domain.
 *   - file-shape guards: always 200, has a try/catch + Sentry, no merchant
 *     existence assumption (.single() / lookup-then-delete-by-id).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ─── Mutable harness state (read inside the hoisted vi.mock factories) ────────
let webhookShop = "example.myshopify.com";
let deleteCalls: Array<{ table: string; column: string; value: string }> = [];
let merchantsDeleteError: { message: string } | null = null;
let sessionsDeleteError: { message: string } | null = null;
let rejectMerchantsDelete = false; // simulate a client-level throw, not a {error}
let captureCalls: Array<{ err: unknown; ctx: { extra?: { shop?: string } } }> = [];

vi.mock("../app/shopify.server", () => ({
  // HMAC verification is assumed to pass here — these tests exercise the
  // post-auth delete path. Bad-HMAC 401 is the library's contract, unchanged.
  authenticate: {
    webhook: async () => ({ shop: webhookShop }),
  },
}));

vi.mock("../app/supabase.server", () => {
  // Chainable mock: supabase.from(table).delete().eq(column, value) → { error }.
  const fromBuilder = (table: string) => {
    let mode: "delete" | null = null;
    const chain: Record<string, (...a: any[]) => any> = {
      delete: () => {
        mode = "delete";
        return chain;
      },
      eq: (column: string, value: string) => {
        if (mode === "delete") deleteCalls.push({ table, column, value });
        return chain;
      },
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
        if (table === "merchants") {
          if (rejectMerchantsDelete) {
            const e = new Error("network down");
            return reject ? reject(e) : Promise.reject(e);
          }
          return resolve({ error: merchantsDeleteError });
        }
        if (table === "sessions") {
          return resolve({ error: sessionsDeleteError });
        }
        return resolve({ error: null });
      },
    };
    return chain;
  };
  return { supabase: { from: (t: string) => fromBuilder(t) } };
});

vi.mock("../app/lib/sentry.server", () => ({
  sentry: {
    captureException: (err: unknown, ctx: { extra?: { shop?: string } }) => {
      captureCalls.push({ err, ctx });
    },
    addBreadcrumb: () => {},
    captureMessage: () => {},
  },
}));

import { action } from "../app/routes/webhooks.shop.redact";

function makeRedactRequest() {
  return new Request("http://localhost/webhooks/shop/redact", {
    method: "POST",
    headers: { "X-Shopify-Hmac-Sha256": "test-hmac" },
    body: JSON.stringify({ shop_domain: webhookShop }),
  });
}

const run = () =>
  action({
    request: makeRedactRequest(),
  } as unknown as Parameters<typeof action>[0]);

describe("webhooks.shop.redact — runtime behavior", () => {
  beforeEach(() => {
    webhookShop = "example.myshopify.com";
    deleteCalls = [];
    merchantsDeleteError = null;
    sessionsDeleteError = null;
    rejectMerchantsDelete = false;
    captureCalls = [];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("redact for a NON-existent merchant → 200, no throw, no Sentry", async () => {
    // delete().eq() of zero rows returns { error: null } in supabase — the
    // handler must not assume a row existed.
    webhookShop = "never-installed.myshopify.com";
    const res = await run();
    expect(res.status).toBe(200);
    expect(captureCalls).toHaveLength(0);
    // Still issued the delete keyed by shop domain (idempotent no-op).
    expect(deleteCalls).toContainEqual({
      table: "merchants",
      column: "shopify_domain",
      value: "never-installed.myshopify.com",
    });
  });

  it("redact for an existing merchant → deletes by shop domain (cascade) + 200", async () => {
    webhookShop = "bybaanoo.myshopify.com";
    const res = await run();
    expect(res.status).toBe(200);
    // Hard-delete is issued on merchants by shopify_domain — ON DELETE CASCADE
    // (asserted at the migration level in bug-fixes.test.ts) removes children.
    expect(deleteCalls).toContainEqual({
      table: "merchants",
      column: "shopify_domain",
      value: "bybaanoo.myshopify.com",
    });
    // Lingering sessions are cleared too.
    expect(deleteCalls).toContainEqual({
      table: "sessions",
      column: "shop",
      value: "bybaanoo.myshopify.com",
    });
    expect(captureCalls).toHaveLength(0);
  });

  it("a Postgres delete error → STILL 200, captured to Sentry with the shop", async () => {
    merchantsDeleteError = { message: "permission denied" };
    const res = await run();
    expect(res.status).toBe(200);
    expect(captureCalls).toHaveLength(1);
    expect(captureCalls[0].ctx.extra?.shop).toBe("example.myshopify.com");
  });

  it("a client-level rejection (network) → STILL 200, captured to Sentry", async () => {
    rejectMerchantsDelete = true;
    const res = await run();
    expect(res.status).toBe(200);
    expect(captureCalls).toHaveLength(1);
    expect(captureCalls[0].ctx.extra?.shop).toBe("example.myshopify.com");
  });
});

describe("webhooks.shop.redact — file shape", () => {
  const src = readFileSync(
    join(__dirname, "..", "app", "routes", "webhooks.shop.redact.tsx"),
    "utf8",
  );

  it("always returns 200 after attempting deletion", () => {
    expect(src).toMatch(/new Response\(null,\s*\{\s*status:\s*200\s*\}\)/);
  });

  it("deletes by shop domain directly (no lookup-then-delete-by-id round trip)", () => {
    expect(src).toMatch(/\.delete\(\)\s*\n?\s*\.eq\("shopify_domain"/);
    // The merchant id is never selected/used — delete is keyed by domain.
    expect(src).not.toMatch(/\.eq\("id",\s*merchant\.id\)/);
  });

  it("captures failures to Sentry with the shop domain", () => {
    expect(src).toContain("sentry.captureException");
    expect(src).toMatch(/extra:\s*\{\s*shop\s*\}/);
  });
});
