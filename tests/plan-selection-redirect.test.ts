/**
 * tests/plan-selection-redirect.test.ts
 *
 * BEHAVIOURAL proof for the one-time plan-selection redirect.
 *
 * THE GAP. Shopify App Pricing does not show the plan picker on its own — its
 * docs put that redirect on the app. ShieldKit never did it, so Shopify
 * auto-enrolled every install on the Free plan and the paid plan was only ever
 * reachable through an in-app Upgrade button. Months of Partner events are a
 * solid wall of "Free - Free subscription" activations: nobody was declining
 * Monitoring, nobody was being shown it. On 2026-08-03 that was 57 free
 * merchants against 2 real payers.
 *
 * These tests drive the REAL app.tsx layout loader against an in-memory
 * merchant row, so they assert the merchant-visible outcome (did the browser
 * get sent to the picker, did the row get stamped) rather than the source text.
 *
 * The three cases that matter most are the ones that must NOT redirect:
 * redirecting twice is a loop that locks a merchant out of the app entirely,
 * which is far worse than the missed picker it would be protecting against.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── The row under test ──────────────────────────────────────────────────────
let tier = "free";
let planSelectionShownAt: string | null = null;
let stampShouldFail = false;
/** Every write the loader made to merchants.plan_selection_shown_at. */
let stamps: Array<string | null> = [];

vi.mock("../app/supabase.server", () => {
  const makeChain = (table: string) => {
    const chain: Record<string, (...a: any[]) => any> = {
      select: () => chain,
      update: (p: any) => {
        if (table === "merchants" && p && "plan_selection_shown_at" in p) {
          if (!stampShouldFail) {
            planSelectionShownAt = p.plan_selection_shown_at;
            stamps.push(p.plan_selection_shown_at);
          }
        }
        return chain;
      },
      eq: () => chain,
      maybeSingle: async () => {
        if (table === "merchants") {
          return {
            data: { tier, plan_selection_shown_at: planSelectionShownAt },
            error: null,
          };
        }
        return { data: null, error: null };
      },
      // `await supabase.from(...).update(...).eq(...)` resolves here.
      then: (resolve: (v: unknown) => void) =>
        resolve({
          data: null,
          error: stampShouldFail ? { message: "stamp write failed" } : null,
        }),
    };
    return chain;
  };
  return { supabase: { from: (t: string) => makeChain(t) } };
});

/** Records what the Shopify redirect helper was asked to do. */
let redirectCalls: Array<{ url: string; target?: string }> = [];

vi.mock("../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({
      session: { shop: "test-store.myshopify.com" },
      redirect: (url: string, init?: { target?: string }) => {
        redirectCalls.push({ url, target: init?.target });
        return new Response(null, { status: 302, headers: { Location: url } });
      },
    }),
  },
}));

beforeEach(() => {
  tier = "free";
  planSelectionShownAt = null;
  stampShouldFail = false;
  stamps = [];
  redirectCalls = [];
  process.env.SHOPIFY_APP_HANDLE = "shieldkit";
  process.env.SHOPIFY_API_KEY = "test-api-key";
  vi.resetModules();
});

async function loadApp() {
  const { loader } = await import("../app/routes/app");
  const args = {
    request: new Request("https://x/app"),
    params: {},
    context: {},
  } as unknown as Parameters<typeof loader>[0];
  return loader(args);
}

describe("first-time free merchant is sent to the plan picker", () => {
  it("redirects to the managed-pricing page with target _top", async () => {
    const result = await loadApp();

    expect(redirectCalls).toHaveLength(1);
    expect(redirectCalls[0].url).toBe(
      "https://admin.shopify.com/store/test-store/charges/shieldkit/pricing_plans",
    );
    // Without _top the redirect renders nothing: admin.shopify.com sends
    // X-Frame-Options: DENY and the app is in an iframe.
    expect(redirectCalls[0].target).toBe("_top");
    expect(result).toBeInstanceOf(Response);
  });

  it("stamps the row BEFORE redirecting, so the picker cannot loop", async () => {
    await loadApp();
    expect(stamps).toHaveLength(1);
    expect(planSelectionShownAt).not.toBeNull();
  });

  it("does not redirect a second time", async () => {
    await loadApp();
    expect(redirectCalls).toHaveLength(1);

    redirectCalls = [];
    const second = await loadApp();

    expect(redirectCalls).toEqual([]);
    // Second visit renders the app normally.
    expect(second).not.toBeInstanceOf(Response);
    expect((second as any).tier).toBe("free");
  });
});

describe("cases that must NOT redirect", () => {
  it("a paid merchant is never bounced to the picker", async () => {
    tier = "monitoring";
    const result = await loadApp();

    expect(redirectCalls).toEqual([]);
    expect(stamps).toEqual([]);
    expect((result as any).tier).toBe("monitoring");
  });

  it("an already-stamped free merchant stays in the app", async () => {
    planSelectionShownAt = "2026-08-01T00:00:00.000Z";
    const result = await loadApp();

    expect(redirectCalls).toEqual([]);
    expect(result).not.toBeInstanceOf(Response);
  });

  it("a failed stamp suppresses the redirect (a loop is worse than a missed picker)", async () => {
    stampShouldFail = true;
    const result = await loadApp();

    // The whole point: we could not record that we showed the picker, so we
    // must not show it — otherwise every /app/* load redirects forever and the
    // merchant can never reach the app.
    expect(redirectCalls).toEqual([]);
    expect(result).not.toBeInstanceOf(Response);
  });

  it("a missing SHOPIFY_APP_HANDLE cannot take down the whole /app layout", async () => {
    delete process.env.SHOPIFY_APP_HANDLE;

    // getManagedPricingUrl throws when the handle is unset. This is the LAYOUT
    // loader — an uncaught throw here breaks every /app/* route, not just this
    // feature.
    const result = await loadApp();

    expect(redirectCalls).toEqual([]);
    expect(result).not.toBeInstanceOf(Response);
    expect((result as any).tier).toBe("free");
  });
});
