/**
 * tests/beacon-cross-promo.test.ts
 *
 * Beacon cross-promo card in the ShieldKit dashboard aside.
 *  - URL lives in a single named constant (BEACON_LISTING_URL).
 *  - Card renders for ALL tiers (not gated by isPaid).
 *  - Button opens the App Store externally (window.open _blank) — a raw <a>
 *    or _self would reload the embedded iframe.
 */

import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { BEACON_LISTING_URL } from "../app/lib/constants";

const APP_DIR = path.resolve(__dirname, "../app");
const dashboard = fs.readFileSync(
  path.join(APP_DIR, "routes/app._index.tsx"),
  "utf-8",
);

describe("Beacon cross-promo card", () => {
  it("exposes the live listing URL as a single named constant", () => {
    expect(BEACON_LISTING_URL).toBe("https://apps.shopify.com/beacon-4");
  });

  it("renders a Beacon card with a 'Get Beacon' button in the aside", () => {
    expect(dashboard).toContain("New from ShieldKit: Beacon");
    expect(dashboard).toContain("Get Beacon");
    // Lives in the aside like the other aside cards.
    const beaconIdx = dashboard.indexOf("New from ShieldKit: Beacon");
    const asideSectionIdx = dashboard.lastIndexOf('slot="aside"', beaconIdx);
    expect(asideSectionIdx).toBeGreaterThan(-1);
  });

  it("targets the constant, not a hardcoded URL", () => {
    expect(dashboard).toContain("BEACON_LISTING_URL");
    expect(dashboard).toContain(
      'import { BEACON_LISTING_URL } from "../lib/constants"',
    );
  });

  it("opens the App Store externally without reloading the iframe", () => {
    // Reuses the review banner's pattern: window.open(url, "_blank", ...).
    expect(dashboard).toMatch(
      /window\.open\(\s*BEACON_LISTING_URL,\s*"_blank",\s*"noopener,noreferrer"\s*\)/,
    );
  });

  it("is shown to all tiers — the card is not gated behind isPaid", () => {
    // Isolate the Beacon <s-section> and assert no isPaid guard wraps it.
    const start = dashboard.indexOf("New from ShieldKit: Beacon");
    // Walk back to the opening comment / section for the Beacon block.
    const blockStart = dashboard.lastIndexOf("Beacon cross-promo", start - 1);
    expect(blockStart).toBeGreaterThan(-1);
    const block = dashboard.slice(blockStart, start + 400);
    expect(block).not.toContain("isPaid");
    expect(block).not.toContain("showOnboarding");
  });
});
