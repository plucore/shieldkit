/**
 * tests/appeal-ux-and-dashes.test.ts
 *
 * Regression suite for the 2026-07-12 appeal-UX + dash-cleanup pass:
 *   PART 1/2 — the appeal Generate button is driven by useFetcher (busy state
 *              actually binds, so it single-flights and shows loading/disabled),
 *              and the result renders from fetcher.data (no manual refresh).
 *   PART 3   — at-cap messaging on the appeal page.
 *   PART 4   — collapsed, dated history titles with per-day ordinals.
 *   PART 5   — no em/en dashes: prompt rule in both generators + a post-process
 *              normalizer that strips them from generated copy.
 */

import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { normalizeDashes } from "../app/lib/text-normalize";
import { buildHistoryTitles } from "../app/lib/appeal-history";
import { buildPolicySystemPrompt } from "../app/lib/policy-generator.server";
import type { ShopInfo } from "../app/lib/shopify-api.server";

const APP_DIR = path.resolve(__dirname, "../app");

// ─── PART 5 — dash normalizer ────────────────────────────────────────────────

describe("normalizeDashes (PART 5)", () => {
  it("replaces an em dash used as punctuation with a comma + space", () => {
    expect(normalizeDashes("text — text")).toBe("text, text");
    expect(normalizeDashes("text—text")).toBe("text, text");
  });

  it("replaces an en dash in a numeric range with a hyphen", () => {
    expect(normalizeDashes("1–3")).toBe("1-3");
    expect(normalizeDashes("3 – 5 business days")).toBe("3-5 business days");
  });

  it("replaces an en dash used as punctuation with a comma + space", () => {
    expect(normalizeDashes("handmade – custom – vintage")).toBe(
      "handmade, custom, vintage",
    );
  });

  it("never alters existing ASCII hyphens or hyphenated words", () => {
    expect(normalizeDashes("30-day return window")).toBe("30-day return window");
    expect(normalizeDashes("state-of-the-art")).toBe("state-of-the-art");
    expect(normalizeDashes("1-3")).toBe("1-3");
    expect(normalizeDashes("no dashes here")).toBe("no dashes here");
  });

  it("is a no-op on empty input", () => {
    expect(normalizeDashes("")).toBe("");
  });
});

// ─── PART 5 — generators forbid + strip dashes ───────────────────────────────

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

describe("generator prompts forbid em/en dashes (PART 5)", () => {
  it("policy prompt builder includes the no-dash rule", () => {
    const prompt = buildPolicySystemPrompt("refund", SHOP, {
      todayIso: "2026-07-12",
      contactEmail: "help@store.com",
    });
    expect(prompt).toMatch(/Do NOT use em dashes.*or en dashes/i);
  });

  it("appeal-letter prompt includes the no-dash rule", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "lib/llm/appeal-letter.server.ts"),
      "utf-8",
    );
    expect(src).toMatch(/Do NOT use em dashes.*or en dashes/i);
  });

  it("both generators post-process output through normalizeDashes", () => {
    const policy = fs.readFileSync(
      path.join(APP_DIR, "lib/policy-generator.server.ts"),
      "utf-8",
    );
    const appeal = fs.readFileSync(
      path.join(APP_DIR, "lib/llm/appeal-letter.server.ts"),
      "utf-8",
    );
    expect(policy).toContain("normalizeDashes");
    expect(appeal).toContain("normalizeDashes");
  });
});

// ─── PART 4 — collapsed dated history titles ─────────────────────────────────

describe("buildHistoryTitles (PART 4)", () => {
  const entries = [
    // newest-first, as the loader returns them
    { id: "c", createdAt: "2026-07-12T15:00:00Z", suspensionReason: null, letter: "x" },
    { id: "b", createdAt: "2026-07-12T12:00:00Z", suspensionReason: null, letter: "x" },
    { id: "a", createdAt: "2026-07-12T09:00:00Z", suspensionReason: null, letter: "x" },
    { id: "z", createdAt: "2026-07-11T10:00:00Z", suspensionReason: null, letter: "x" },
  ];
  const titles = buildHistoryTitles(entries);

  it("titles by type + ISO date", () => {
    expect(titles.z).toBe("Appeal letter, 2026-07-11");
  });

  it("suffixes -N in that day's generation order (oldest = 1)", () => {
    expect(titles.a).toBe("Appeal letter, 2026-07-12-1");
    expect(titles.b).toBe("Appeal letter, 2026-07-12-2");
    expect(titles.c).toBe("Appeal letter, 2026-07-12-3");
  });

  it("omits the suffix when a day has a single letter", () => {
    expect(titles.z).not.toMatch(/-\d$/);
  });

  it("uses commas and plain hyphens only, never em/en dashes", () => {
    for (const t of Object.values(titles)) {
      expect(t).not.toMatch(/[—–]/);
    }
  });
});

// ─── PART 1/2 — appeal route is fetcher-driven ───────────────────────────────

describe("appeal route is fetcher-driven (PART 1 + 2)", () => {
  const src = fs.readFileSync(
    path.join(APP_DIR, "routes/app.appeal-letter.tsx"),
    "utf-8",
  );

  it("uses useFetcher so the busy state binds (no untracked native form POST)", () => {
    expect(src).toContain("useFetcher");
    expect(src).toContain('fetcher.state !== "idle"');
    expect(src).toContain("fetcher.submit(formRef.current");
    // The raw-form / navigation submit path that never tracked busy is gone.
    expect(src).not.toContain("requestSubmit");
    expect(src).not.toContain('<form method="post"');
    expect(src).not.toMatch(/useNavigation\(\)/); // not used as the busy source
  });

  it("single-flights the Generate button and disables it while busy / at cap", () => {
    expect(src).toContain("useSingleFlight");
    expect(src).toContain("submitDisabled");
    expect(src).toMatch(/const atCap = remaining === 0/);
  });

  it("renders the just-generated letter + Copy button from fetcher.data (no refresh)", () => {
    expect(src).toContain("const result = fetcher.data");
    expect(src).toMatch(/result\?\.ok && result\.letter/);
    expect(src).toContain("CopyButton");
  });

  it("surfaces the at-cap limit message on the appeal page (PART 3)", () => {
    expect(src).toContain("Appeal letter limit reached");
    expect(src).toMatch(/You've reached the limit of \{limit\} appeal letters/);
  });

  it("history is a collapsed accordion of dated entries (PART 4)", () => {
    expect(src).toContain("buildHistoryTitles");
    expect(src).toContain("<details");
    expect(src).toContain("<summary");
  });
});
