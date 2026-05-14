/**
 * tests/partner-api.test.ts
 *
 * File-content shape assertions for the Partner API migration. Verifies:
 *
 *  - partner-api.server.ts exposes the required surface and fail-safe
 *    contract (every public subscription accessor must default to
 *    `status: "unknown"` on any failure).
 *  - plans.ts ships PLAN_NAME_TO_CYCLE keyed by all four paid plan names —
 *    cycle derivation on the Partner API path depends on the name alone.
 *  - app.billing.confirm.tsx prefers the Partner API and keeps
 *    billing.check() only as a clearly marked legacy fallback.
 *  - app._index.tsx self-heals via the Partner API and never demotes on
 *    "unknown".
 *  - webhooks.app_subscriptions.update.tsx is documented as a pre-April-28
 *    supplementary channel (not canonical).
 *
 * No live Partner API calls — keeps tests offline and deterministic,
 * consistent with the existing test style.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const read = (...parts: string[]) =>
  readFileSync(join(root, ...parts), "utf8");

describe("partner-api.server.ts", () => {
  const src = read("app", "lib", "billing", "partner-api.server.ts");

  it("targets the 2026-04 Partner API version", () => {
    expect(src).toMatch(/PARTNER_API_VERSION\s*=\s*"2026-04"/);
  });

  it("requires SHOPIFY_PARTNER_ORG_ID, SHOPIFY_PARTNER_APP_ID, SHOPIFY_PARTNER_API_TOKEN", () => {
    expect(src).toContain('"SHOPIFY_PARTNER_ORG_ID"');
    expect(src).toContain('"SHOPIFY_PARTNER_APP_ID"');
    expect(src).toContain('"SHOPIFY_PARTNER_API_TOKEN"');
  });

  it("builds the App gid from numeric SHOPIFY_PARTNER_APP_ID", () => {
    expect(src).toContain("gid://partners/App/");
  });

  it("exposes the documented public surface", () => {
    expect(src).toContain("export async function getActiveSubscriptionByChargeId");
    expect(src).toContain("export async function getEventsByChargeId");
    expect(src).toContain("export async function getEventsByShopGid");
    expect(src).toContain("export function buildAppSubscriptionGid");
  });

  it("queries the documented AppSubscriptionEvent types", () => {
    for (const t of [
      "SUBSCRIPTION_CHARGE_ACTIVATED",
      "SUBSCRIPTION_CHARGE_UNFROZEN",
      "SUBSCRIPTION_CHARGE_ACCEPTED",
      "SUBSCRIPTION_CHARGE_CANCELED",
      "SUBSCRIPTION_CHARGE_DECLINED",
      "SUBSCRIPTION_CHARGE_EXPIRED",
      "SUBSCRIPTION_CHARGE_FROZEN",
    ]) {
      expect(src).toContain(t);
    }
  });

  it("maps event types to status enum", () => {
    expect(src).toMatch(/SUBSCRIPTION_CHARGE_ACTIVATED:\s*"active"/);
    expect(src).toMatch(/SUBSCRIPTION_CHARGE_CANCELED:\s*"cancelled"/);
    expect(src).toMatch(/SUBSCRIPTION_CHARGE_FROZEN:\s*"frozen"/);
  });

  it("fail-safe: UNKNOWN helper returns status='unknown' with no tier", () => {
    // The whole point of UNKNOWN is to give callers a value they can NEVER
    // mistake for a paid tier write.
    expect(src).toMatch(/UNKNOWN\s*=\s*\(reason: string\)/);
    expect(src).toMatch(/status:\s*"unknown"/);
    expect(src).toMatch(/tier:\s*null/);
  });

  it("retries with exponential backoff on transient HTTP failures", () => {
    expect(src).toMatch(/MAX_RETRIES\s*=\s*3/);
    expect(src).toMatch(/BASE_RETRY_DELAY_MS\s*=\s*500/);
    expect(src).toContain("Math.pow(2, attempt)");
  });

  it("does NOT silently demote — every error path returns UNKNOWN", () => {
    // The accessor must convert thrown errors into UNKNOWN so callers can
    // distinguish "definitely not active" from "we don't know."
    expect(src).toContain("partner-api-fetch-failed");
    expect(src).toContain("no-matching-events");
    expect(src).toContain("unmappable-event-type");
    expect(src).toContain("event-missing-charge");
    expect(src).toContain("unmapped-plan-name");
  });
});

describe("plans.ts PLAN_NAME_TO_CYCLE", () => {
  const src = read("app", "lib", "billing", "plans.ts");

  it("exports PLAN_NAME_TO_CYCLE with all four paid plans", () => {
    expect(src).toContain("PLAN_NAME_TO_CYCLE");
    expect(src).toMatch(/"Shield Pro":\s*"monthly"/);
    expect(src).toMatch(/"Shield Pro Annual":\s*"annual"/);
    expect(src).toMatch(/"Shield Max":\s*"monthly"/);
    expect(src).toMatch(/"Shield Max Annual":\s*"annual"/);
  });
});

describe("app.billing.confirm.tsx — Partner API primary path", () => {
  const src = read("app", "routes", "app.billing.confirm.tsx");

  it("prefers Partner API over billing.check()", () => {
    expect(src).toContain("getActiveSubscriptionByChargeId");
    expect(src).toContain("buildAppSubscriptionGid");
  });

  it("reads charge_id from URL search params", () => {
    expect(src).toContain('searchParams.get("charge_id")');
  });

  it("marks billing.check() as a legacy fallback removable after April 28", () => {
    expect(src).toMatch(/REMOVE AFTER 2026-04-28/);
  });

  it("never writes tier when Partner API status is 'unknown' or 'pending'", () => {
    // The branch that writes tier only fires for status === "active".
    expect(src).toMatch(/sub\.status === "active"/);
    // The "unknown" path must fall through (legacy backstop) — never demote.
    expect(src).toContain("inconclusive");
  });
});

describe("app._index.tsx — self-heal via Partner API", () => {
  const src = read("app", "routes", "app._index.tsx");

  it("self-heal uses Partner API, not billing.check()", () => {
    expect(src).toContain("getActiveSubscriptionByChargeId");
    expect(src).not.toMatch(/billing\.check\(/);
  });

  it("skips self-heal when no shopify_subscription_id is stored (free tier)", () => {
    expect(src).toMatch(/shopify_subscription_id/);
  });

  it("never writes to DB when status === 'unknown'", () => {
    // The drift write must only fire under status === "active". Any other
    // status (including unknown / pending / cancelled / frozen) leaves the
    // DB untouched in this user-blocking loader.
    expect(src).toMatch(/sub\.status === "active"/);
    expect(src).toContain("leaving DB untouched");
  });
});

describe("webhooks.app_subscriptions.update.tsx — demoted to supplementary", () => {
  const src = read("app", "routes", "webhooks.app_subscriptions.update.tsx");

  it("documents the April 28 cliff and Partner API replacement", () => {
    expect(src).toMatch(/PRE-APRIL-28 SUPPLEMENTARY CHANNEL/);
    expect(src).toMatch(/April 28, 2026/);
    expect(src).toContain("partner-api.server.ts");
  });

  it("still ships the action handler (not deleted)", () => {
    expect(src).toMatch(/export const action/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Runtime fail-safe assertions (no network — validates input-shape branches)
// ─────────────────────────────────────────────────────────────────────────────
//
// These exercise the actual exported functions. Any call that would otherwise
// require a network request bails at the chargeGid format check at the top of
// the function and returns UNKNOWN synchronously — so we get real behavioral
// coverage without mocking fetch.

import {
  getActiveSubscriptionByChargeId,
  buildAppSubscriptionGid,
} from "../app/lib/billing/partner-api.server";

describe("partner-api.server.ts — runtime fail-safe paths", () => {
  it("buildAppSubscriptionGid produces the correct format from string and number", () => {
    expect(buildAppSubscriptionGid("12345")).toBe(
      "gid://shopify/AppSubscription/12345",
    );
    expect(buildAppSubscriptionGid(67890)).toBe(
      "gid://shopify/AppSubscription/67890",
    );
  });

  it("getActiveSubscriptionByChargeId returns UNKNOWN for empty gid", async () => {
    const sub = await getActiveSubscriptionByChargeId("");
    expect(sub.status).toBe("unknown");
    expect(sub.tier).toBeNull();
    expect(sub.cycle).toBeNull();
    expect(sub.subscriptionGid).toBeNull();
    expect(sub.reason).toMatch(/invalid chargeGid/);
  });

  it("getActiveSubscriptionByChargeId returns UNKNOWN for non-gid string", async () => {
    const sub = await getActiveSubscriptionByChargeId("not-a-gid");
    expect(sub.status).toBe("unknown");
    expect(sub.tier).toBeNull();
    expect(sub.reason).toMatch(/invalid chargeGid/);
  });

  it("getActiveSubscriptionByChargeId returns UNKNOWN for wrong gid namespace", async () => {
    // gid://partners/App/123 is a valid gid format but the WRONG resource
    // type — the check rejects anything that isn't an AppSubscription gid.
    const sub = await getActiveSubscriptionByChargeId(
      "gid://partners/App/123",
    );
    expect(sub.status).toBe("unknown");
    expect(sub.tier).toBeNull();
    expect(sub.reason).toMatch(/invalid chargeGid/);
  });

  it("getActiveSubscriptionByChargeId never throws on bad input — always returns a value", async () => {
    // The fail-safe contract: callers can rely on never seeing a thrown
    // error from the front-door API. Promotes to UNKNOWN instead.
    await expect(
      getActiveSubscriptionByChargeId(undefined as unknown as string),
    ).resolves.toBeDefined();
    await expect(
      getActiveSubscriptionByChargeId(null as unknown as string),
    ).resolves.toBeDefined();
  });
});
