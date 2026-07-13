/**
 * tests/policy-international-framing.test.ts
 *
 * Regression guard for the 2026-07-13 pass that softens the defensive
 * international / customs framing in the AI policy generator.
 *
 * The generator prompts were leading with (and over-stressing) three defensive
 * patterns: "customs duties are the buyer's problem", sanctions / embargo
 * clauses, and a restocking fee when a customer refuses a shipment over customs.
 * This suite pins the de-emphasis instruction into the shipping, refund, and
 * terms prompts.
 *
 * CRITICAL invariant it protects: the softening must NOT become a domestic-only
 * hardcode. The app has no ship-to data at prompt time (ShopInfo carries none),
 * so a false "domestic only" scope for a store that ships worldwide would be its
 * own GMC misrepresentation. The rule therefore keeps international coverage
 * present and explicitly forbids a domestic-only claim.
 *
 * buildPolicySystemPrompt is a pure exported function, so these assertions run
 * against the REAL built prompt, not a grep of the source.
 */

import { describe, it, expect } from "vitest";
import {
  buildPolicySystemPrompt,
  INTERNATIONAL_FRAMING_RULE,
  type PolicyContext,
  type PolicyType,
} from "../app/lib/policy-generator.server";
import type { ShopInfo } from "../app/lib/shopify-api.server";

const SHOP: ShopInfo = {
  name: "Test Store",
  contactEmail: "help@store.com",
  billingAddress: {
    address1: null,
    city: null,
    province: null,
    country: "United States",
    zip: null,
  },
  myshopifyDomain: "test.myshopify.com",
  currencyCode: "USD",
  primaryDomain: { url: "https://test.com", host: "test.com" },
  shopOwnerName: null,
  ianaTimezone: null,
  createdAt: null,
  plan: { displayName: null, shopifyPlus: null, partnerDevelopment: null },
};

const CTX: PolicyContext = {
  todayIso: "2026-07-13",
  contactEmail: "help@store.com",
};

const build = (t: PolicyType): string => buildPolicySystemPrompt(t, SHOP, CTX);

// The policy types that receive the softened framing.
const SOFTENED: PolicyType[] = ["shipping", "refund", "terms"];

describe("policy prompts soften international / customs framing (Part 3)", () => {
  it("the rule de-emphasizes the three defensive patterns", () => {
    expect(INTERNATIONAL_FRAMING_RULE).toContain(
      "Do NOT lead with defensive international disclaimers",
    );
    // customs-duties-are-your-problem
    expect(INTERNATIONAL_FRAMING_RULE).toMatch(
      /customs-duties-are-the-customer's-responsibility/,
    );
    // sanctions / embargo clauses
    expect(INTERNATIONAL_FRAMING_RULE).toMatch(/sanctions \/ embargo/);
    // restocking-fee-on-customs-refusal
    expect(INTERNATIONAL_FRAMING_RULE).toContain(
      "restocking fee charged when a customer refuses a delivery over customs",
    );
  });

  it.each(SOFTENED)(
    "injects the de-emphasis instruction into the %s prompt",
    (t) => {
      const prompt = build(t);
      expect(prompt).toContain("International framing (applies to this policy):");
      expect(prompt).toContain(
        "Do NOT lead with defensive international disclaimers",
      );
    },
  );

  it("does NOT add the international framing to the privacy prompt", () => {
    const prompt = build("privacy");
    expect(prompt).not.toContain(
      "International framing (applies to this policy):",
    );
    expect(prompt).not.toContain(
      "Do NOT lead with defensive international disclaimers",
    );
  });

  it("never hardcodes domestic-only (forbids the misrepresentation instead)", () => {
    // The guard is what stops the softening from flipping into a false
    // domestic-only scope for a store that actually ships worldwide.
    expect(INTERNATIONAL_FRAMING_RULE).toMatch(
      /Do NOT state or imply the store ships only within one country/,
    );
    expect(INTERNATIONAL_FRAMING_RULE).toContain(
      "A false domestic-only claim is itself a misrepresentation for a store that ships worldwide",
    );
  });

  it("neutralizes the billing Country line and carries NO domestic-only escape hatch", () => {
    // The prompt already emits `Country: <registration country>` (a merchant
    // registration field, not a ship-to scope). The rule must tell the model not
    // to read it as a shipping scope, and must NOT carry an escape clause that
    // could latch onto it and re-introduce the domestic-only misrepresentation.
    expect(INTERNATIONAL_FRAMING_RULE).toContain(
      "it is the store's registration country, not a statement of where the store ships",
    );
    expect(INTERNATIONAL_FRAMING_RULE).not.toMatch(
      /unless the store data explicitly establishes/i,
    );
  });

  it("keeps international shipping coverage present, not stripped", () => {
    const prompt = build("shipping");
    // Existing per-type bullets still ask for international coverage...
    expect(prompt.toLowerCase()).toContain("international");
    // ...and the rule requires it to stay accurate + present, not removed.
    expect(prompt).toContain("keep that coverage accurate and present");
  });
});
