/**
 * tests/model-pin.test.ts
 *
 * Regression guard for the Anthropic model string used by the two LLM call
 * sites (policy generator + appeal-letter generator).
 *
 * Why this exists:
 * On 2026-07-12 a bump from `claude-sonnet-4-20250514` → `claude-sonnet-4-6`
 * shipped, but the earlier edit was briefly reverted into a git stash during a
 * recovery and there was NO test pinning the model string — so a regression
 * could ship green and only surface in production as a runtime
 * `404 not_found_error {"message":"model: claude-sonnet-4-20250514"}` from the
 * Anthropic SDK (paid-only feature, rarely exercised, easy to miss).
 *
 * These are file-content assertions on the REAL source files (same style as the
 * rest of the suite) so a wrong/retired model literal fails CI instead of prod.
 *
 * When intentionally bumping the model, update EXPECTED_MODEL below (one place).
 */

import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";

const APP_DIR = path.resolve(__dirname, "../app");

// The model both LLM call sites must use. Update this (and only this) on a
// deliberate model bump.
const EXPECTED_MODEL = "claude-sonnet-4-6";

// Model IDs that must never appear again — the retired Sonnet 4 snapshot that
// caused the production 404, plus any dated Sonnet-4 snapshot form.
const RETIRED_MODEL = "claude-sonnet-4-20250514";
const DATED_SONNET_4_SNAPSHOT = /claude-sonnet-4-\d{8}/;

// The server files that call the Anthropic API. Keep this list in sync with
// every `messages.create({ model: ... })` call site.
const LLM_CALL_SITES = [
  "lib/policy-generator.server.ts",
  "lib/llm/appeal-letter.server.ts",
] as const;

describe("Anthropic model string is pinned to claude-sonnet-4-6", () => {
  for (const relPath of LLM_CALL_SITES) {
    const absPath = path.join(APP_DIR, relPath);

    describe(relPath, () => {
      const content = fs.readFileSync(absPath, "utf-8");

      it("does NOT contain the retired claude-sonnet-4-20250514 string", () => {
        expect(content).not.toContain(RETIRED_MODEL);
      });

      it("does NOT contain any dated Sonnet-4 snapshot (claude-sonnet-4-YYYYMMDD)", () => {
        expect(content).not.toMatch(DATED_SONNET_4_SNAPSHOT);
      });

      it(`references model "${EXPECTED_MODEL}"`, () => {
        expect(content).toContain(EXPECTED_MODEL);
      });

      it(`passes model: "${EXPECTED_MODEL}" to messages.create`, () => {
        expect(content).toMatch(
          new RegExp(`model:\\s*["']${EXPECTED_MODEL}["']`),
        );
      });
    });
  }
});

// The model-pin test above stops a bad model string at the source, but the alert
// that catches a model retired AFTER we pin it (env drift, Anthropic retiring an
// id, a new call site) lives in Sentry — and it only works if the Anthropic 404
// actually reaches Sentry. Both LLM call sites originally let the error propagate
// to a route catch that returned a 500 WITHOUT capturing it, so the alert would
// have fired on nothing. This guards the capture. See docs/sentry-alerts-runbook.md.
describe("LLM call sites report Anthropic errors to Sentry (SHIELDKIT-1 alert has a signal)", () => {
  for (const relPath of LLM_CALL_SITES) {
    const absPath = path.join(APP_DIR, relPath);

    describe(relPath, () => {
      const content = fs.readFileSync(absPath, "utf-8");

      it("imports the Sentry wrapper", () => {
        expect(content).toMatch(/from ["']\.\.?\/sentry\.server["']/);
      });

      it("captures the Anthropic error on the messages.create failure path", () => {
        expect(content).toContain("captureException");
        // capture-and-rethrow: the error is reported AND still propagates, so the
        // caller's existing error handling is unchanged.
        expect(content).toMatch(/\.catch\(/);
        expect(content).toMatch(/throw err/);
      });
    });
  }
});
