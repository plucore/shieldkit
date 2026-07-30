/**
 * tests/typecheck-gate.test.ts
 *
 * Guards the shape of app/polaris-jsx.d.ts.
 *
 * `npm run typecheck` carried 44 standing errors, so it could never pass and was
 * not a gate: proving "no regression" in PR #19 meant stashing a base commit and
 * diffing error sets by hand. The ambient file took it to 1.
 *
 * The risk now is the opposite one. It is trivially easy to reach zero by
 * widening everything to `any`, which would silence real bugs — including the
 * one deliberately left visible (`tone="subdued"` in PlanStatusCard, a value
 * that is valid for `background`/`borderColor` but has never been a valid
 * `tone`). These tests make that regression loud.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const dts = readFileSync(join(ROOT, "app/polaris-jsx.d.ts"), "utf-8");

/**
 * Assertions below must read the DECLARATIONS, not the prose. The header
 * deliberately quotes the anti-patterns it avoids (`[tag: string]: any`,
 * `subdued`), and a naive match against the raw file finds those quotes and
 * fails — which is exactly what happened when this suite was first written.
 */
const code = dts
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("the ambient Polaris declarations stay narrow", () => {
  it("declares only the tags the app actually uses — an unknown tag must still fail", () => {
    // A blanket `[tag: string]: any` would make <s-crad> compile.
    expect(code).not.toMatch(/\[\s*(tag|elemName)\s*:\s*string\s*\]\s*:\s*any/);
    for (const tag of [
      "s-page", "s-section", "s-card", "s-paragraph", "s-link",
      "s-text-field", "s-button", "s-banner", "s-badge", "s-icon",
    ]) {
      expect(code).toContain(`"${tag}"`);
    }
  });

  it("keeps `tone` strict — this is what still catches the subdued bug", () => {
    // If someone widens tone to string, PlanStatusCard's invalid value goes
    // silent and the typecheck gate starts lying. The union must match
    // custom-elements.json exactly.
    expect(code).toMatch(/type PolarisTone\s*=/);
    for (const tone of ["auto", "neutral", "info", "success", "caution", "warning", "critical"]) {
      expect(code).toContain(`"${tone}"`);
    }
    expect(code).not.toMatch(/tone\?:\s*string/);
    // "subdued" must NOT be in the tone union — it is a background/borderColor
    // value, and admitting it here would mask the bug rather than fix it.
    expect(code).not.toContain('"subdued"');
  });

  it("does not reintroduce a global JSX index signature", () => {
    // That would silence type checking on EVERY standard HTML element — a far
    // bigger hole than the one being closed.
    expect(code).not.toMatch(/namespace JSX\s*\{[\s\S]{0,200}\[elemName:\s*string\]/);
  });

  it("augments img rather than loosening all of react", () => {
    expect(code).toContain("interface ImgHTMLAttributes");
    expect(code).toContain("fetchpriority");
  });
});

describe("tsconfig no longer loads the stale Polaris types", () => {
  it("drops @shopify/polaris-types from compilerOptions.types", () => {
    const tsconfig = readFileSync(join(ROOT, "tsconfig.json"), "utf-8");
    // The package's IconType union is stale against the custom-elements.json
    // manifest shipped beside it, and it never declared s-card at all.
    expect(tsconfig).not.toContain("@shopify/polaris-types");
  });
});
