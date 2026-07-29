/**
 * tests/reconcile-subscriptions.test.ts
 *
 * Coverage for the daily Partner API reconciliation cron at
 * /api/cron/reconcile-subscriptions. Verifies:
 *
 *  - File-shape contract: bearer-token auth via CRON_SECRET, queries only
 *    PAID_TIERS rows with a non-null shopify_subscription_id, calls
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

  // Was: "requires POST and rejects GET with 405". Inverted 2026-07-28.
  // Vercel Cron invokes scheduled paths with GET, so a POST-only route meant
  // this reconciler had never run in production — the only code path that
  // demotes a merchant on terminal Partner-API status. The loader must now
  // serve the same handler as the action. The security property is unchanged
  // and is asserted separately below: authorisation is the CRON_SECRET bearer
  // check, never the HTTP verb.
  it("serves both GET (Vercel Cron) and POST (GitHub Actions) via one handler", () => {
    expect(src).toMatch(/export async function loader\(\{ request \}/);
    expect(src).toMatch(/export async function action\(\{ request \}/);
    expect(src).toMatch(/async function run\(request: Request\)/);
    // Both entry points delegate rather than duplicating the body.
    expect(src.match(/return run\(request\);/g)?.length).toBe(2);
    // The verb must not be an authorisation gate any more.
    expect(src).not.toMatch(/method !== "POST"/);
  });

  it("authenticates via CRON_SECRET bearer token", () => {
    expect(src).toContain("process.env.CRON_SECRET");
    expect(src).toMatch(/Bearer /);
    expect(src).toContain("unauthorized");
  });

  it("filters merchants by PAID_TIERS and uninstalled_at IS NULL", () => {
    expect(src).toContain("PAID_TIERS");
    expect(src).toMatch(/\.is\("uninstalled_at", null\)/);
  });

  it("only queries merchants that have a stored subscription gid", () => {
    expect(src).toMatch(/\.not\("shopify_subscription_id", "is", null\)/);
  });

  it("looks up status via Partner API", () => {
    expect(src).toContain("getActiveSubscriptionByChargeId");
  });

  it("uses the SHARED terminal-status set, not its own copy", () => {
    // This test previously asserted the cron treated FROZEN as terminal — it
    // locked in the bug. PR #14 removed FROZEN from the webhook's copy and left
    // the cron's copy intact, so for a day the two paths disagreed about the same
    // Shopify event: the webhook correctly ignored a freeze while this cron
    // demoted on it. There is now ONE set in plans.ts and no local copy here.
    expect(src).toMatch(/isTerminalSubscriptionStatus/);
    expect(src).not.toMatch(/const TERMINAL_STATUSES/);
    expect(src).not.toMatch(/"frozen"/);
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
    expect(src).toMatch(/scans_remaining:\s*1/);
    expect(src).toMatch(/scans_reset_at:/);
  });

  // INVERTED 2026-07-28. This previously required the demote to NULL
  // shopify_subscription_id. That NULL was the bug: it erased the only column
  // this job filters on, so a merchant wrongly demoted (as happened to a live
  // $29/mo customer) became permanently invisible to the one job that could
  // restore them.
  it("demote must PRESERVE shopify_subscription_id so a bad demote can self-heal", () => {
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    expect(code).not.toMatch(/shopify_subscription_id:\s*null/);
  });

  it("walks ALL merchants with a charge id, not just already-paid ones", () => {
    // The tier filter is what made recovery impossible: a wrongly-demoted
    // merchant sits at tier='free' and was therefore excluded.
    expect(src).not.toMatch(/\.in\(\s*["']tier["']\s*,\s*PAID_TIERS/);
    expect(src).toMatch(/\.not\(\s*["']shopify_subscription_id["']\s*,\s*["']is["']\s*,\s*null\s*\)/);
  });

  it("guards against re-demoting an already-free row every pass", () => {
    // Widening the query means a free row with a stale cancelled charge id is
    // now visited daily. Without this guard it would fall into the demote block
    // and rewrite scans_remaining: 1 on every run — a daily free-scan refill.
    expect(src).toMatch(/entitledNow/);
    const guardIdx = src.indexOf("if (!entitledNow)");
    const demoteIdx = src.indexOf('tier: "free"');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(demoteIdx);
  });

  it("re-promotes a free row the Partner API still reports as active", () => {
    expect(src).toMatch(/sub\.status === "active" && !entitledNow/);
    expect(src).toMatch(/scans_remaining:\s*null/);
    // Must refuse a TEST charge — no money moves on those.
    expect(src).toMatch(/sub\.test === true/);
    // And must be loud, because a re-promote means something stripped a payer.
    expect(src).toMatch(/captureMessage/);
  });

  it("a thrown Partner API error skips the row without aborting the pass", () => {
    expect(src).toMatch(/lookupErrors/);
    expect(src).toMatch(/branch:\s*"partner_api_lookup"/);
    // try/catch must wrap the lookup, and the catch must `continue`.
    const tryIdx = src.indexOf("getActiveSubscriptionByChargeId(subGid)");
    const after = src.slice(tryIdx);
    expect(after.slice(0, 700)).toMatch(/continue;/);
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

import { action, loader } from "../app/routes/api.cron.reconcile-subscriptions";

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

  // Was: "rejects GET with 405". Inverted 2026-07-28 — see the file-shape note.
  // A GET carrying the correct bearer is exactly how Vercel Cron calls this
  // route, so it must NOT be rejected.
  it("accepts an authorised GET (this is how Vercel Cron invokes it)", async () => {
    const res = await loader({
      request: makeRequest({ method: "GET" }),
    } as unknown as Parameters<typeof loader>[0]);
    expect(res.status).not.toBe(405);
    expect(res.status).toBe(200);
  });

  // The regression that matters: widening the verb must not widen access.
  it("still rejects an UNAUTHORISED GET with 401", async () => {
    const res = await loader({
      request: makeRequest({ method: "GET", auth: "Bearer wrong" }),
    } as unknown as Parameters<typeof loader>[0]);
    expect(res.status).toBe(401);
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
      scans_remaining: 1,
    });
    expect(updateCalls[0].patch.scans_reset_at).toBeDefined();
    // The charge id must SURVIVE the demote so this job can re-check it and
    // re-promote if the demotion turns out to have been wrong (2026-07-28).
    expect(updateCalls[0].patch).not.toHaveProperty("shopify_subscription_id");
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

describe("terminal subscription statuses live in ONE place", () => {
  const plans = readFileSync(join(__dirname, "..", "app", "lib", "billing", "plans.ts"), "utf8");
  const webhook = readFileSync(
    join(__dirname, "..", "app", "routes", "webhooks.app_subscriptions.update.tsx"),
    "utf8",
  );
  const cron = readFileSync(
    join(__dirname, "..", "app", "routes", "api.cron.reconcile-subscriptions.ts"),
    "utf8",
  );

  it("FROZEN is NOT terminal, in the one set that exists", () => {
    // A freeze is recoverable. Treating it as terminal permanently stripped three
    // paying merchants (0yzffh-vw, ygxib5-9s, sbnjen-ee). Fail toward access.
    const m = plans.match(
      /export const TERMINAL_SUBSCRIPTION_STATUSES: readonly string\[\] = \[([\s\S]*?)\];/,
    );
    expect(m).not.toBeNull();
    const body = m![1];
    expect(body).toMatch(/"cancelled"/);
    expect(body).toMatch(/"expired"/);
    expect(body).toMatch(/"declined"/);
    expect(body).not.toMatch(/frozen/i);
  });

  it("neither caller keeps a local copy that could drift", () => {
    for (const [name, src] of [["webhook", webhook], ["cron", cron]] as const) {
      expect(src, `${name} still declares its own set`).not.toMatch(
        /const TERMINAL_STATUSES\s*=/,
      );
      expect(src, `${name} does not use the shared helper`).toMatch(
        /isTerminalSubscriptionStatus\(/,
      );
    }
  });

  it("the helper is case-insensitive, because the two callers pass different casing", () => {
    // Shopify's webhook sends "CANCELLED"; the Partner API mapping yields
    // "cancelled". A case-sensitive shared set would silently stop demoting.
    expect(plans).toMatch(/status\.toLowerCase\(\)/);
  });

  it("the prohibition is recorded where someone would re-add it", () => {
    expect(plans).toMatch(/FROZEN IS NOT TERMINAL AND MUST NOT BE ADDED/);
    expect(plans).toMatch(/SUBSCRIPTION_CHARGE_UNFROZEN/);
  });
});
