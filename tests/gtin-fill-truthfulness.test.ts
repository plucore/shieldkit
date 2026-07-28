/**
 * tests/gtin-fill-truthfulness.test.ts
 *
 * /app/gtin-fill is the one place a merchant PRESSES A BUTTON and reads a number
 * back. It carried the same throttle blindness as the drainer (60df4cd), which is
 * materially worse here: the drainer misled an operator, this misled the customer.
 *
 * Three defects, all fixed:
 *
 *   1. READ — `const conn = json?.data?.products; if (!conn) break;`
 *      A THROTTLED reply is HTTP 200 with `errors[]` and no `data`, so a rate
 *      limit was read as "the catalog ends here". The merchant then saw either a
 *      confident success count or "nothing to write" for a catalog the walk had
 *      not finished reading.
 *
 *   2. WRITE — `json?.data?.metafieldsSet?.userErrors ?? []`
 *      A throttled mutation yields an empty userErrors list from a body with no
 *      data, so `chunkErrored` stayed false and `succeeded += chunk.length`
 *      reported writes that never happened.
 *
 *   3. SILENT CAP — the walk stops after 10 pages x 50 products. A merchant with
 *      7,685 products was told the run had finished after 500.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(
  join(__dirname, "..", "app", "routes", "app.gtin-fill.tsx"),
  "utf8",
);

/**
 * Comment-stripped view, for ORDERING assertions only. The explanatory comments
 * quote the very code they describe (e.g. "`succeeded += chunk.length` reported
 * writes that never happened"), so an indexOf over the raw source matches the
 * comment first and inverts the comparison — which is exactly what happened when
 * this file was written.
 */
const code = src
  .split("\n")
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join("\n");

describe("the candidate walk reports HOW it ended, not just what it found", () => {
  it("a page it could not read is not the end of the catalog", () => {
    expect(src).toMatch(/if \(json\?\.errors\?\.length \|\| !json\?\.data\) \{/);
    expect(src).toMatch(/unavailable: true/);
    // The old unconditional bail must be gone.
    expect(src).not.toMatch(/const conn = json\?\.data\?\.products;\s*\n\s*if \(!conn\) break;/);
  });

  it("distinguishes complete / unavailable / hitPageCap", () => {
    expect(src).toMatch(/complete: boolean/);
    expect(src).toMatch(/unavailable: boolean/);
    expect(src).toMatch(/hitPageCap: boolean/);
    // Only the "Shopify says no more pages" exit may claim completeness.
    expect(src).toMatch(/complete: true, unavailable: false, hitPageCap: false/);
  });

  it("writes NOTHING when the catalog could not be fully read", () => {
    // Acting on a partial candidate list and then showing a success count is how
    // a merchant concludes their catalog is fixed when it is not.
    const idx = src.indexOf("if (walk.unavailable)");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 700);
    expect(block).toMatch(/ok: false/);
    expect(block).toMatch(/succeeded: 0/);
    expect(block).toMatch(/Nothing in your store changed/);
    // ...and it must bail BEFORE the write loop.
    expect(code.indexOf("if (walk.unavailable)")).toBeLessThan(
      code.indexOf("METAFIELDS_SET_MUTATION, {"),
    );
  });

  it("the merchant-facing copy blames us, not them, and de-jargons the cause", () => {
    const idx = src.indexOf("if (walk.unavailable)");
    const block = src.slice(idx, idx + 700);
    expect(block).toMatch(/We could not finish reading your catalog/);
    expect(block).toMatch(/try again/i);
    // No raw mechanism terms in what a merchant reads.
    expect(block).not.toMatch(/THROTTLED|GraphQL|metafieldsSet|HTTP 200/);
  });
});

describe("a throttled write is never counted as a success", () => {
  it("an absent metafieldsSet payload sets chunkErrored", () => {
    const idx = src.indexOf("The false success");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 800);
    expect(block).toMatch(/if \(json\?\.errors\?\.length \|\| !json\?\.data\?\.metafieldsSet\) \{/);
    expect(block).toMatch(/chunkErrored = true/);
  });

  it("the guard runs BEFORE succeeded is incremented", () => {
    expect(code).toMatch(/succeeded \+= chunk\.length/); // the assertion is live
    expect(code.indexOf("!json?.data?.metafieldsSet")).toBeLessThan(
      code.indexOf("succeeded += chunk.length"),
    );
    // ...and the early-exit between them is what makes the ordering matter.
    const between = code.slice(
      code.indexOf("!json?.data?.metafieldsSet"),
      code.indexOf("succeeded += chunk.length"),
    );
    expect(between).toMatch(/if \(chunkErrored\) \{[\s\S]*continue;/);
  });

  it("a genuine userError is still handled", () => {
    // The fix must not swallow the real rejection path it sits in front of.
    expect(src).toMatch(/const userErrors: Array<\{ field: string\[\] \| null; message: string \}> =/);
    expect(src).toMatch(/userErrors\.length > 0/);
  });
});

describe("the 500-product cap is surfaced, not silent", () => {
  it("the walk flags hitPageCap when pages remain", () => {
    expect(src).toMatch(/complete: false, unavailable: false, hitPageCap: true/);
  });

  it("the result carries it to the UI", () => {
    expect(src).toMatch(/catalogTruncated\?: boolean/);
    expect(src).toMatch(/catalogTruncated: walk\.hitPageCap/);
  });

  it("the success banner changes tone and says what was NOT covered", () => {
    expect(src).toMatch(/actionData\.catalogTruncated \? "warning" : "success"/);
    expect(src).toMatch(/Part of your catalog is done/);
    expect(src).toMatch(/PAGE_CAP \* PAGE_SIZE/);
    // And it must point at the automatic path, so a large-catalog merchant is not
    // left thinking they have to keep clicking.
    expect(src).toMatch(/automatically in the background/);
  });
});
