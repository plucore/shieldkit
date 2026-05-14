/**
 * tests/reconcile-subscriptions.test.ts
 *
 * Coverage for the daily Partner API reconciliation cron at
 * /api/cron/reconcile-subscriptions. Verifies:
 *
 *  - File-shape contract: bearer-token auth via CRON_SECRET, queries only
 *    MONITORING_TIERS rows with a non-null shopify_subscription_id, calls
 *    getActiveSubscriptionByChargeId, mirrors the webhook's terminal-status
 *    demote write, and never demotes on status === "unknown".
 *
 *  - Runtime fail-safe: a Supabase + Partner API stub harness drives the
 *    action through three scenarios — cancelled (demote), unknown (skip,
 *    DB untouched), active (skip, DB untouched).
 *
 *  - vercel.json registers the cron entry on a daily schedule.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const read = (...parts: string[]) =>
  readFileSync(join(root, ...parts), "utf8");

// ─────────────────────────────────────────────────────────────────────────────
// File-shape assertions
// ─────────────────────────────────────────────────────────────────────────────

describe("api.cron.reconcile-subscriptions.ts — file shape", () => {
  const src = read("app", "routes", "api.cron.reconcile-subscriptions.ts");

  it("requires POST and rejects GET with 405", () => {
    expect(src).toMatch(/method !== "POST"/);
    expect(src).toContain("method_not_allowed");
  });

  it("authenticates via CRON_SECRET bearer token", () => {
    expect(src).toContain("process.env.CRON_SECRET");
    expect(src).toMatch(/Bearer /);
    expect(src).toContain("unauthorized");
  });

  it("filters merchants by MONITORING_TIERS and uninstalled_at IS NULL", () => {
    expect(src).toContain("MONITORING_TIERS");
    expect(src).toMatch(/\.is\("uninstalled_at", null\)/);
  });

  it("only queries merchants that have a stored subscription gid", () => {
    expect(src).toMatch(/\.not\("shopify_subscription_id", "is", null\)/);
  });

  it("looks up status via Partner API", () => {
    expect(src).toContain("getActiveSubscriptionByChargeId");
  });

  it("treats cancelled / expired / frozen / declined as terminal", () => {
    // Must match the same set the webhook treats as terminal.
    expect(src).toContain('"cancelled"');
    expect(src).toContain('"expired"');
    expect(src).toContain('"frozen"');
    expect(src).toContain('"declined"');
  });

  it("never demotes on status='unknown' — fail-safe is documented and enforced", () => {
    expect(src).toContain('sub.status === "unknown"');
    expect(src).toMatch(/skippedUnknown/);
    // Comment must spell out the contract for future maintainers.
    expect(src).toMatch(/MUST NOT demote/i);
  });

  it("demote write mirrors the APP_SUBSCRIPTIONS_UPDATE webhook terminal reset", () => {
    expect(src).toMatch(/tier:\s*"free"/);
    expect(src).toMatch(/billing_cycle:\s*null/);
    expect(src).toMatch(/subscription_started_at:\s*null/);
    expect(src).toMatch(/shopify_subscription_id:\s*null/);
    expect(src).toMatch(/scans_remaining:\s*1/);
    expect(src).toMatch(/scans_reset_at:/);
  });

  it("notes the Hobby-tier scaling ceiling", () => {
    expect(src).toMatch(/Hobby/);
    expect(src).toMatch(/60s/);
  });
});

describe("vercel.json — reconcile cron registration", () => {
  const src = read("vercel.json");
  const parsed = JSON.parse(src) as {
    crons: Array<{ path: string; schedule: string }>;
  };
  const entry = parsed.crons.find(
    (c) => c.path === "/api/cron/reconcile-subscriptions",
  );

  it("registers /api/cron/reconcile-subscriptions", () => {
    expect(entry).toBeDefined();
  });

  it("runs daily (5-field cron with daily cadence)", () => {
    expect(entry?.schedule).toBeDefined();
    // Vercel Hobby supports daily crons. The schedule should be a valid 5-field
    // expression and the day-of-month / day-of-week / month fields should all
    // be wildcards so it actually runs every day.
    const parts = (entry!.schedule).split(/\s+/);
    expect(parts.length).toBe(5);
    expect(parts[2]).toBe("*"); // day of month
    expect(parts[3]).toBe("*"); // month
    expect(parts[4]).toBe("*"); // day of week
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Runtime behavior — Supabase + Partner API stubbed in-place
// ─────────────────────────────────────────────────────────────────────────────

// In-test mutable handles, set per-case.
let merchantRows: Array<{
  id: string;
  shopify_domain: string;
  tier: string;
  shopify_subscription_id: string;
}> = [];
let partnerApiResponse: {
  status: string;
  tier: string | null;
  cycle: string | null;
  subscriptionGid: string | null;
  planName: string | null;
  billingOn: string | null;
  activatedAt: string | null;
  test: boolean | null;
  reason: string | null;
} | null = null;
let updateCalls: Array<{ id: string; patch: Record<string, unknown> }> = [];

vi.mock("../app/supabase.server", () => {
  // Minimal chainable mock matching the surface the cron uses:
  //   supabase.from("merchants").select(...).in(...).is(...).not(...) → { data, error }
  //   supabase.from("merchants").update({...}).eq("id", id) → { error }
  const fromBuilder = () => {
    const ctx: { mode: "select" | "update" | null; patch?: Record<string, unknown> } = {
      mode: null,
    };
    const chain: Record<string, (...args: any[]) => any> = {
      select: () => chain,
      in: () => chain,
      is: () => chain,
      not: () => chain,
      eq: () => chain,
      update: (patch: Record<string, unknown>) => {
        ctx.mode = "update";
        ctx.patch = patch;
        return chain;
      },
      then: (resolve: (v: unknown) => void) => {
        if (ctx.mode === "update") {
          // `.eq("id", id)` was the last call — but we need the id. The cron
          // builder passes id via .eq, captured here. For test simplicity we
          // record the patch against the first remaining merchant row that
          // matches; the cron only updates by id and we replay sequentially.
          const row = merchantRows[updateCalls.length];
          updateCalls.push({ id: row?.id ?? "unknown", patch: ctx.patch! });
          return resolve({ error: null });
        }
        return resolve({ data: merchantRows, error: null });
      },
    };
    return chain;
  };
  return {
    supabase: {
      from: () => fromBuilder(),
    },
  };
});

vi.mock("../app/lib/billing/partner-api.server", () => ({
  getActiveSubscriptionByChargeId: vi.fn(async () => partnerApiResponse),
}));

import { action } from "../app/routes/api.cron.reconcile-subscriptions";

function makeRequest(opts: { method?: string; auth?: string | null } = {}) {
  const headers = new Headers();
  if (opts.auth !== null) {
    headers.set("Authorization", opts.auth ?? "Bearer test-secret");
  }
  return new Request("http://localhost/api/cron/reconcile-subscriptions", {
    method: opts.method ?? "POST",
    headers,
  });
}

describe("reconcile-subscriptions action — runtime behavior", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "test-secret";
    merchantRows = [];
    partnerApiResponse = null;
    updateCalls = [];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("rejects GET with 405", async () => {
    const res = await action({
      request: makeRequest({ method: "GET" }),
    } as unknown as Parameters<typeof action>[0]);
    expect(res.status).toBe(405);
  });

  it("rejects missing/invalid bearer token with 401", async () => {
    const res = await action({
      request: makeRequest({ auth: "Bearer wrong" }),
    } as unknown as Parameters<typeof action>[0]);
    expect(res.status).toBe(401);
  });

  it("returns 500 when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;
    const res = await action({
      request: makeRequest(),
    } as unknown as Parameters<typeof action>[0]);
    expect(res.status).toBe(500);
  });

  it("demotes a merchant when Partner API returns a terminal status", async () => {
    merchantRows = [
      {
        id: "m-1",
        shopify_domain: "cancelled-shop.myshopify.com",
        tier: "monitoring",
        shopify_subscription_id: "gid://shopify/AppSubscription/1",
      },
    ];
    partnerApiResponse = {
      status: "cancelled",
      tier: null,
      cycle: null,
      subscriptionGid: "gid://shopify/AppSubscription/1",
      planName: "Monitoring",
      billingOn: null,
      activatedAt: null,
      test: false,
      reason: null,
    };

    const res = await action({
      request: makeRequest(),
    } as unknown as Parameters<typeof action>[0]);
    const body = (await res.json()) as {
      demoted: number;
      skipped_unknown: number;
      still_active: number;
    };

    expect(res.status).toBe(200);
    expect(body.demoted).toBe(1);
    expect(body.skipped_unknown).toBe(0);
    expect(body.still_active).toBe(0);

    // Exactly one DB write — the demote — and it mirrors the webhook's reset.
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0].patch).toMatchObject({
      tier: "free",
      billing_cycle: null,
      subscription_started_at: null,
      shopify_subscription_id: null,
      scans_remaining: 1,
    });
    expect(updateCalls[0].patch.scans_reset_at).toBeDefined();
  });

  it("FAIL-SAFE: does NOT demote when Partner API returns status='unknown'", async () => {
    // This is the load-bearing test. A network blip or transient GraphQL
    // error must never strip features from a paying customer.
    merchantRows = [
      {
        id: "m-2",
        shopify_domain: "transient-error.myshopify.com",
        tier: "recovery",
        shopify_subscription_id: "gid://shopify/AppSubscription/2",
      },
    ];
    partnerApiResponse = {
      status: "unknown",
      tier: null,
      cycle: null,
      subscriptionGid: null,
      planName: null,
      billingOn: null,
      activatedAt: null,
      test: null,
      reason: "partner-api-fetch-failed",
    };

    const res = await action({
      request: makeRequest(),
    } as unknown as Parameters<typeof action>[0]);
    const body = (await res.json()) as {
      demoted: number;
      skipped_unknown: number;
    };

    expect(res.status).toBe(200);
    expect(body.demoted).toBe(0);
    expect(body.skipped_unknown).toBe(1);

    // No DB writes whatsoever. The merchant's tier is untouched.
    expect(updateCalls.length).toBe(0);
  });

  it("does NOT demote when Partner API reports active", async () => {
    merchantRows = [
      {
        id: "m-3",
        shopify_domain: "still-paying.myshopify.com",
        tier: "pro",
        shopify_subscription_id: "gid://shopify/AppSubscription/3",
      },
    ];
    partnerApiResponse = {
      status: "active",
      tier: "pro",
      cycle: "monthly",
      subscriptionGid: "gid://shopify/AppSubscription/3",
      planName: "Shield Max",
      billingOn: "2026-06-14",
      activatedAt: "2026-05-14T00:00:00Z",
      test: false,
      reason: null,
    };

    const res = await action({
      request: makeRequest(),
    } as unknown as Parameters<typeof action>[0]);
    const body = (await res.json()) as {
      demoted: number;
      still_active: number;
    };

    expect(body.demoted).toBe(0);
    expect(body.still_active).toBe(1);
    expect(updateCalls.length).toBe(0);
  });

  it("handles an empty merchant list cleanly", async () => {
    merchantRows = [];
    const res = await action({
      request: makeRequest(),
    } as unknown as Parameters<typeof action>[0]);
    const body = (await res.json()) as {
      checked: number;
      demoted: number;
    };
    expect(body.checked).toBe(0);
    expect(body.demoted).toBe(0);
  });
});
