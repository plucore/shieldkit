/**
 * tests/atomic-generation-caps.test.ts
 *
 * Regression suite for SHIELDKIT-2 (2026-07-12):
 *
 *   PART 1 — race-safe generation caps. The appeal per-scan cap and the policy
 *            per-type regen cap were non-atomic count-then-write (TOCTOU), so
 *            concurrent submits could each slip under the cap. Live incident:
 *            5 appeal letters generated for one scan. Now enforced via the
 *            insert_appeal_letter_if_under_cap / claim_policy_regen RPCs.
 *   PART 2 — generation/mutation buttons single-flight so mashing can't fire
 *            concurrent POSTs (the atomic caps are the real backstop).
 *   PART 3 — policy generator quality: 8192 max_tokens (no mid-sentence
 *            truncation), server-injected date, a REAL resolved contact (never
 *            a fabricated one), and no leaked Markdown code fence.
 *
 * buildPolicySystemPrompt is a pure exported function so the date/contact
 * grounding is exercised for real (not just grepped).
 */

import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import {
  buildPolicySystemPrompt,
  resolvePolicyContact,
  stripCodeFence,
  CONTACT_PLACEHOLDER,
} from "../app/lib/policy-generator.server";
import type { ShopInfo } from "../app/lib/shopify-api.server";

const APP_DIR = path.resolve(__dirname, "../app");
const ROOT_DIR = path.resolve(__dirname, "..");
const MIGRATION = path.join(
  ROOT_DIR,
  "supabase/migrations/20260712000000_atomic_generation_caps.sql",
);

const SHOP: ShopInfo = {
  name: "Test Store",
  contactEmail: "shop-level@example.com",
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

// ─── PART 3 — policy prompt grounding (real function) ────────────────────────

describe("policy prompt grounding (SHIELDKIT-2 PART 3)", () => {
  it("injects the server-computed date verbatim and forbids any other date", () => {
    const prompt = buildPolicySystemPrompt("terms", SHOP, {
      todayIso: "2026-07-12",
      contactEmail: "help@store.com",
    });
    expect(prompt).toContain("2026-07-12");
    expect(prompt).toMatch(/use EXACTLY this date/i);
    expect(prompt).toMatch(/do NOT rely on your training data for the current date/i);
  });

  it("uses the resolved real contact and forbids inventing another", () => {
    const prompt = buildPolicySystemPrompt("refund", SHOP, {
      todayIso: "2026-07-12",
      contactEmail: "help@store.com",
    });
    expect(prompt).toContain("help@store.com");
    expect(prompt).toMatch(/Use ONLY this address/i);
    expect(prompt).toMatch(/Do NOT invent, guess, or derive/i);
  });

  it("emits a placeholder (never fabricates) when no contact email is on file", () => {
    const prompt = buildPolicySystemPrompt("privacy", SHOP, {
      todayIso: "2026-07-12",
      contactEmail: null,
    });
    expect(prompt).toContain(CONTACT_PLACEHOLDER);
    expect(prompt).toMatch(/Do NOT invent, guess, or derive/i);
    expect(prompt).not.toContain("Use ONLY this address"); // the real-email branch
  });

  it("tells the model not to wrap the output in a Markdown code fence", () => {
    const prompt = buildPolicySystemPrompt("shipping", SHOP, {
      todayIso: "2026-07-12",
      contactEmail: null,
    });
    expect(prompt).toMatch(/code fence/i);
  });
});

describe("contact resolution precedence (SHIELDKIT-2 PART 3)", () => {
  it("prefers pro_settings.support_email, then contact_email, then shop email", () => {
    expect(resolvePolicyContact("pro@x.com", "c@x.com", "shop@x.com")).toBe("pro@x.com");
    expect(resolvePolicyContact(null, "c@x.com", "shop@x.com")).toBe("c@x.com");
    expect(resolvePolicyContact("  ", "", "shop@x.com")).toBe("shop@x.com");
    expect(resolvePolicyContact(undefined, "  ", "  ")).toBeNull();
    expect(resolvePolicyContact(null, null, null)).toBeNull();
  });

  it("a null resolution feeds the placeholder, never a fabricated address", () => {
    const contact = resolvePolicyContact(null, null, null);
    expect(contact).toBeNull();
    const prompt = buildPolicySystemPrompt("refund", SHOP, {
      todayIso: "2026-07-12",
      contactEmail: contact,
    });
    expect(prompt).toContain(CONTACT_PLACEHOLDER);
  });
});

describe("stripCodeFence (SHIELDKIT-2 PART 3)", () => {
  it("strips a leading ```html / ``` fence and the trailing fence", () => {
    expect(stripCodeFence("```html\n<h2>Hi</h2>\n```")).toBe("<h2>Hi</h2>");
    expect(stripCodeFence("```\n<p>x</p>\n```")).toBe("<p>x</p>");
  });

  it("leaves fence-free HTML untouched", () => {
    const html = "<h2>Refund</h2><p>body</p>";
    expect(stripCodeFence(html)).toBe(html);
  });

  it("does not strip inline single backticks that aren't a wrapping fence", () => {
    const html = "<p>Use `code` inline</p>";
    expect(stripCodeFence(html)).toBe(html);
  });
});

describe("policy generator quality (SHIELDKIT-2 PART 3)", () => {
  const src = fs.readFileSync(
    path.join(APP_DIR, "lib/policy-generator.server.ts"),
    "utf-8",
  );

  it("raises max_tokens to 8192 (2048 truncated policies mid-sentence)", () => {
    expect(src).toMatch(/max_tokens:\s*8192/);
    expect(src).not.toMatch(/max_tokens:\s*2048/);
  });

  it("warns via Sentry when a generation is truncated at max_tokens", () => {
    expect(src).toContain("stop_reason");
    expect(src).toContain('=== "max_tokens"');
    expect(src).toContain("captureMessage");
  });

  it("strips a leaked Markdown code fence before storing", () => {
    expect(src).toContain("stripCodeFence");
  });

  it("takes a PolicyContext (date + contact), not a bare shopInfo", () => {
    expect(src).toMatch(/export interface PolicyContext/);
    expect(src).toContain("todayIso");
    expect(src).toContain("contactEmail");
  });

  it("keeps the model pinned to claude-sonnet-4-6", () => {
    expect(src).toMatch(/model:\s*"claude-sonnet-4-6"/);
  });
});

describe("appeal-letter generator (SHIELDKIT-2 PART 3)", () => {
  const src = fs.readFileSync(
    path.join(APP_DIR, "lib/llm/appeal-letter.server.ts"),
    "utf-8",
  );

  it("threads today's date into the prompt", () => {
    expect(src).toContain("todayIso");
    expect(src).toContain("${todayIso}");
    expect(src).toMatch(/use today's date exactly/i);
  });

  it("leaves the grounding rules intact (no fabricated fixes)", () => {
    expect(src).toContain("STRICT GROUNDING RULES");
    expect(src).toMatch(/NEVER invent/);
  });

  it("leaves max_tokens at 1024 (short letter, no truncation risk)", () => {
    expect(src).toMatch(/max_tokens:\s*1024/);
  });
});

// ─── PART 1 — atomic caps ────────────────────────────────────────────────────

describe("atomic appeal-letter cap (SHIELDKIT-2 PART 1)", () => {
  const migration = fs.readFileSync(MIGRATION, "utf-8");
  const schema = fs.readFileSync(path.join(ROOT_DIR, "supabase/schema.sql"), "utf-8");
  const helper = fs.readFileSync(
    path.join(APP_DIR, "lib/appeal-letters.server.ts"),
    "utf-8",
  );
  const route = fs.readFileSync(
    path.join(APP_DIR, "routes/app.appeal-letter.tsx"),
    "utf-8",
  );

  it("migration defines the cap RPC with a per-scan advisory lock + reserve-insert", () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION insert_appeal_letter_if_under_cap/,
    );
    expect(migration).toContain("pg_advisory_xact_lock(hashtext(p_scan_id::text))");
    expect(migration).toMatch(/count\(\*\)/);
    expect(migration).toMatch(/v_count >= p_cap/);
    expect(migration).toMatch(/INSERT INTO appeal_letters/);
  });

  it("schema.sql carries the SHIELDKIT-2 functions for bootstrap parity", () => {
    expect(schema).toContain("insert_appeal_letter_if_under_cap");
    expect(schema).toContain("finalize_policy_regen");
  });

  it("helper reserves via the RPC with a fallback, plus finalize + release", () => {
    expect(helper).toContain("insert_appeal_letter_if_under_cap");
    expect(helper).toContain("export async function reserveAppealSlot");
    expect(helper).toContain("export async function finalizeAppealSlot");
    expect(helper).toContain("export async function releaseAppealSlot");
    // Degraded (non-atomic) path when the RPC isn't deployed.
    expect(helper).toContain("fallbackReserve");
  });

  it("route reserves the cap slot BEFORE spending an AI credit or model call", () => {
    const reserveIdx = route.indexOf("reserveAppealSlot(");
    const creditIdx = route.indexOf("checkAndConsumeAiCredit(");
    const generateIdx = route.indexOf("generateAppealLetter(");
    expect(reserveIdx).toBeGreaterThan(0);
    expect(creditIdx).toBeGreaterThan(reserveIdx);
    expect(generateIdx).toBeGreaterThan(creditIdx);
  });

  it("rejects an over-cap reservation with 429 (so it never reaches the credit)", () => {
    // The short-circuit is the whole invariant: without this guard the ordering
    // above would still pass but an over-cap attempt would fall through to the
    // AI credit + model call.
    expect(route).toContain("!reservation.accepted");
    expect(route).toMatch(/!reservation\.accepted[\s\S]{0,400}status:\s*429/);
  });

  it("route finalizes on success and releases the slot on all 4 failure paths", () => {
    expect(route).toContain("finalizeAppealSlot(");
    // Released when: AI cap denies, shopInfo missing, generation throws,
    // generation too short — one release per failure path (>= 4).
    const releases = route.match(/releaseAppealSlot\(/g) ?? [];
    expect(releases.length).toBeGreaterThanOrEqual(4);
  });

  it("no longer does a non-atomic count-then-insert in the route", () => {
    expect(route).not.toMatch(/\.from\("appeal_letters"\)\s*\.insert\(/);
    expect(route).not.toMatch(/count[\s\S]{0,120}>= APPEAL_LIMIT_PER_SCAN/);
  });

  it("loader cap-count excludes NULL reservations so a leaked row can't self-lock the button", () => {
    // usedCount must count only finalized letters; otherwise a leaked
    // reservation inflates it, disables the button, and blocks the reserve RPC
    // that reclaims stale rows (the self-lock the review caught).
    const loaderCount = route.match(
      /const \{ count \}[\s\S]{0,320}?\.eq\("scan_id", latestScan\.id\)[\s\S]{0,120}?;/,
    );
    expect(loaderCount).not.toBeNull();
    expect(loaderCount![0]).toContain('.not("generated_letter", "is", null)');
  });
});

describe("atomic policy regen cap (SHIELDKIT-2 PART 1)", () => {
  const migration = fs.readFileSync(MIGRATION, "utf-8");
  const route = fs.readFileSync(
    path.join(APP_DIR, "routes/app._index.tsx"),
    "utf-8",
  );

  it("migration defines finalize_policy_regen (one atomic conditional jsonb UPDATE of both columns)", () => {
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION finalize_policy_regen/);
    expect(migration).toContain("jsonb_set");
    expect(migration).toContain("policy_regen_used");
    expect(migration).toContain("generated_policies");
    // The superseded claim-before pair must be dropped, not left dangling.
    expect(migration).toContain("DROP FUNCTION IF EXISTS claim_policy_regen");
    expect(migration).toContain("DROP FUNCTION IF EXISTS release_policy_regen");
  });

  it("finalizes the regen atomically AFTER generation (claim-after avoids the crash-burn)", () => {
    const creditIdx = route.indexOf("checkAndConsumeAiCredit(merchant.id)");
    const genIdx = route.indexOf("generatePolicy(policyType, shopInfo, policyContext)");
    const finalizeIdx = route.indexOf("finalize_policy_regen");
    expect(creditIdx).toBeGreaterThan(0);
    expect(genIdx).toBeGreaterThan(creditIdx);
    expect(finalizeIdx).toBeGreaterThan(genIdx);
    // No claim-before / release: a crash before finalize leaves the regen unspent.
    expect(route).not.toContain("claim_policy_regen");
    expect(route).not.toContain("release_policy_regen");
    expect(route).not.toContain("releaseRegenOnFailure");
  });

  it("rejects the regen race loser without exceeding the cap", () => {
    // Zero rows back from finalize_policy_regen = someone already claimed it →
    // the loser is rejected (regen_exhausted) AFTER the finalize call, distinct
    // from the fast-path regen_exhausted at the top of the action.
    const finalizeIdx = route.indexOf("finalize_policy_regen");
    const loserRejectIdx = route.lastIndexOf("regen_exhausted");
    expect(finalizeIdx).toBeGreaterThan(0);
    expect(loserRejectIdx).toBeGreaterThan(finalizeIdx);
  });
});

// ─── PART 2 — button single-flight ───────────────────────────────────────────

describe("generation buttons single-flight (SHIELDKIT-2 PART 2)", () => {
  it("useSingleFlight hook exists with a synchronous fired-guard", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "hooks/useSingleFlight.ts"),
      "utf-8",
    );
    expect(src).toContain("export function useSingleFlight");
    expect(src).toContain("firedRef");
  });

  it("useWebComponentClick accepts a disabled gate that ignores clicks in flight", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "hooks/useWebComponentClick.ts"),
      "utf-8",
    );
    expect(src).toMatch(/disabled = false/);
    expect(src).toContain("if (disabled) return");
  });

  it("dashboard guards run-scan, upgrade, plan-switcher, and enable-JSON-LD", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "routes/app._index.tsx"),
      "utf-8",
    );
    expect(src).toContain("useSingleFlight");
    expect(src).toContain("guardedRunScan");
    expect(src).toContain("guardedEnableJsonLd");
    // Re-scan primary button now DISABLES while scanning, not just loading.
    expect(src).toMatch(/isScanning \? \{ loading: "", disabled: "" \}/);
    // Onboarding CTA no longer double-fires (form submit + ref handler).
    expect(src).not.toContain('submit=""');
  });

  it("appeal, GTIN, and policy-card buttons guard against double-submit", () => {
    const appeal = fs.readFileSync(
      path.join(APP_DIR, "routes/app.appeal-letter.tsx"),
      "utf-8",
    );
    expect(appeal).toContain("useSingleFlight");
    expect(appeal).toContain("submitOnce");

    const gtin = fs.readFileSync(
      path.join(APP_DIR, "routes/app.gtin-fill.tsx"),
      "utf-8",
    );
    expect(gtin).toContain("useSingleFlight");
    expect(gtin).toContain("actionsDisabled");

    const card = fs.readFileSync(
      path.join(APP_DIR, "components/PolicyGenerationCard.tsx"),
      "utf-8",
    );
    expect(card).toContain("submitLockRef");
  });
});
