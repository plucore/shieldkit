/**
 * CLI-mirror parity guard (P2-5).
 *
 * scripts/outbound-scanner.ts must run standalone (node --experimental-strip-types),
 * so it cannot import the shared detectors and instead keeps a hand-copied MIRROR
 * of the regexes, payment lists, and JSON-LD offer helpers. That is the exact
 * triple-copy pattern that caused the 2026-07 false-positive incident, so this
 * test asserts the mirror stays byte-equal to the app source of truth. If you
 * change a detector in constants.ts / shared/html-detectors.server.ts, mirror it
 * into outbound-scanner.ts (and vice-versa) or this fails.
 *
 * File-content assertions (the repo's dominant test style) — the CLI cannot be
 * imported because it runs main() on load.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf-8");

const constantsSrc = read("app/lib/checks/constants.ts");
const sharedSrc = read("app/lib/checks/shared/html-detectors.server.ts");
const cliSrc = read("scripts/outbound-scanner.ts");

/** Value assigned to `const NAME = ...;` (up to the first semicolon), whitespace-collapsed. */
function assignment(src: string, name: string): string | null {
  const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*([\\s\\S]*?);`));
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
}

/** Quoted string elements inside a `const NAME = [ ... ]` array literal, in order. */
function arrayElements(src: string, name: string): string[] | null {
  const raw = assignment(src, name);
  if (raw === null) return null;
  return (raw.match(/["']([^"']+)["']/g) ?? []).map((s) => s.slice(1, -1));
}

/** Body `{...}` of `function NAME(...)`, normalized (whitespace/braces/semicolons stripped). */
function fnBody(src: string, name: string): string | null {
  const start = src.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (start < 0) return null;
  const open = src.indexOf("{", start);
  if (open < 0) return null;
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, j + 1).replace(/[{};\s]+/g, " ").trim();
    }
  }
  return null;
}

describe("CLI-mirror parity — outbound-scanner.ts vs the shared detectors", () => {
  // Regex literals must be byte-identical (source of truth → CLI mirror).
  const REGEX_MIRRORS: Array<[string, string]> = [
    ["SOCIAL_RE", constantsSrc],
    ["PHONE_RE", sharedSrc],
    ["EMAIL_RE", sharedSrc],
    ["ADDRESS_RE", sharedSrc],
    ["PO_BOX_RE", sharedSrc],
  ];

  for (const [name, canonicalSrc] of REGEX_MIRRORS) {
    it(`${name} literal is identical in the CLI mirror`, () => {
      const canonical = assignment(canonicalSrc, name);
      expect(canonical, `${name} not found in source of truth`).not.toBeNull();
      expect(assignment(cliSrc, name)).toBe(canonical);
    });
  }

  it("the contact-link regex literal appears verbatim in the CLI mirror", () => {
    const canonical = assignment(sharedSrc, "CONTACT_LINK_RE");
    expect(canonical).not.toBeNull();
    // The CLI uses the same literal inline (not as a named const).
    expect(cliSrc.replace(/\s+/g, " ")).toContain(canonical!);
  });

  it("PAYMENT_KEYWORDS is identical (same elements, same order)", () => {
    const canonical = arrayElements(constantsSrc, "PAYMENT_KEYWORDS");
    expect(canonical?.length).toBeGreaterThan(0);
    expect(arrayElements(cliSrc, "PAYMENT_KEYWORDS")).toEqual(canonical);
  });

  it("PAYMENT_STRUCTURAL_SIGNALS is identical (same elements, same order)", () => {
    const canonical = arrayElements(constantsSrc, "PAYMENT_STRUCTURAL_SIGNALS");
    expect(canonical?.length).toBeGreaterThan(0);
    expect(arrayElements(cliSrc, "PAYMENT_STRUCTURAL_SIGNALS")).toEqual(canonical);
  });

  // JSON-LD offer helpers: bodies must match (modulo brace/semicolon style).
  for (const name of ["normalizeOffers", "offerHasPrice", "offerHasCurrency"]) {
    it(`${name} body matches in the CLI mirror`, () => {
      const canonical = fnBody(sharedSrc, name);
      expect(canonical, `${name} not found in shared module`).not.toBeNull();
      expect(fnBody(cliSrc, name)).toBe(canonical);
    });
  }
});
