/**
 * tests/bug-fixes.test.ts
 *
 * Regression tests for the 5 bugs fixed on feature/new-pricing.
 *
 * Bug 1: Unicode escape characters rendering as literal text
 * Bug 2: Pro tier scan decrement bug
 * Bug 3: Scan History navigation not working
 * Bug 4/5: Upgrade button not redirecting to Shopify billing
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const APP_DIR = path.resolve(__dirname, "../app");

// ─── Bug 1: No raw \uXXXX escape sequences in app/ source files ─────────────

describe("Bug 1: Unicode escape characters", () => {
  it("should have no raw \\uXXXX escape sequences in any .ts/.tsx file under app/", () => {
    // Use grep to find literal backslash-u-XXXX patterns in source files.
    let output = "";
    try {
      output = execFileSync(
        "grep",
        ["-rn", "\\\\u[0-9a-fA-F]\\{4\\}", "--include=*.ts", "--include=*.tsx", APP_DIR],
        { encoding: "utf-8" }
      );
    } catch {
      // grep exits with code 1 when no matches are found — that's the success case
      output = "";
    }

    expect(output).toBe("");
  });
});

// ─── Bug 2: Pro tier scan decrement logic ────────────────────────────────────

describe("Bug 2: Scan decrement guard", () => {
  /**
   * Extracted decrement guard logic — mirrors the check used in
   * app._index.tsx and api.scan.ts after the fix.
   */
  function shouldDecrement(scansRemaining: number | null | undefined): boolean {
    return typeof scansRemaining === "number" && scansRemaining > 0;
  }

  it("should NOT decrement when scans_remaining is null (Pro tier / unlimited)", () => {
    expect(shouldDecrement(null)).toBe(false);
  });

  it("should decrement when scans_remaining is 1", () => {
    expect(shouldDecrement(1)).toBe(true);
  });

  it("should NOT decrement when scans_remaining is 0 (exhausted)", () => {
    expect(shouldDecrement(0)).toBe(false);
  });

  it("should NOT decrement when scans_remaining is undefined", () => {
    expect(shouldDecrement(undefined)).toBe(false);
  });

  it("should decrement when scans_remaining is > 1", () => {
    expect(shouldDecrement(5)).toBe(true);
  });

  it("app._index.tsx uses the correct guard", () => {
    const content = fs.readFileSync(
      path.join(APP_DIR, "routes/app._index.tsx"),
      "utf-8"
    );
    expect(content).toContain(
      'typeof scansRemaining === "number" && scansRemaining > 0'
    );
  });

  it("api.scan.ts uses the correct guard", () => {
    const content = fs.readFileSync(
      path.join(APP_DIR, "routes/api.scan.ts"),
      "utf-8"
    );
    expect(content).toContain(
      'typeof scansRemaining === "number" && scansRemaining > 0'
    );
  });
});

// ─── Bug 3: Scan History route and navigation ────────────────────────────────

describe("Bug 3: Scan History navigation", () => {
  const scanHistoryContent = fs.readFileSync(
    path.join(APP_DIR, "routes/app.scan-history.tsx"),
    "utf-8"
  );

  it("app.scan-history.tsx exports a default component", () => {
    expect(scanHistoryContent).toMatch(/export\s+default\s+function\s+\w+/);
  });

  it("app.scan-history.tsx exports a loader function", () => {
    expect(scanHistoryContent).toMatch(/export\s+const\s+loader\s*=/);
  });

  it("app.scan-history.tsx route file exists and is non-empty", () => {
    expect(scanHistoryContent.length).toBeGreaterThan(100);
  });

  it("app.tsx navigation uses <a> tags, not <s-link>", () => {
    const content = fs.readFileSync(
      path.join(APP_DIR, "routes/app.tsx"),
      "utf-8"
    );
    // Should use <a> tags for navigation
    expect(content).toContain('<a href="/app">Dashboard</a>');
    expect(content).toContain('<a href="/app/scan-history">Scan History</a>');
    // Should NOT use <s-link> for navigation
    expect(content).not.toMatch(/<s-link[^>]*href="\/app/);
  });
});

// ─── Bug 4/5: Upgrade route and billing flow ────────────────────────────────

describe("Bug 4/5: Upgrade billing flow", () => {
  const upgradeContent = fs.readFileSync(
    path.join(APP_DIR, "routes/app.upgrade.tsx"),
    "utf-8"
  );

  it("app.upgrade.tsx exports a loader function", () => {
    expect(upgradeContent).toMatch(/export\s+const\s+loader\s*=/);
  });

  it("app.upgrade.tsx exports an ErrorBoundary", () => {
    expect(upgradeContent).toMatch(/export\s+function\s+ErrorBoundary/);
  });

  it("upgrade route imports and uses PLAN_PRO from shopify.server.ts", () => {
    expect(upgradeContent).toContain("PLAN_PRO");
    // Verify shopify.server.ts defines PLAN_PRO as "Pro"
    const shopifyContent = fs.readFileSync(
      path.join(APP_DIR, "shopify.server.ts"),
      "utf-8"
    );
    expect(shopifyContent).toMatch(/PLAN_PRO\s*=\s*"Pro"/);
  });

  it("upgrade route checks for existing subscription before billing.request()", () => {
    expect(upgradeContent).toContain("billing.check(");
    expect(upgradeContent).toContain("hasActivePayment");

    // await billing.check() must appear BEFORE await billing.request()
    const checkIndex = upgradeContent.indexOf("await billing.check(");
    const requestIndex = upgradeContent.indexOf("await billing.request(");
    expect(checkIndex).toBeGreaterThan(-1);
    expect(requestIndex).toBeGreaterThan(-1);
    expect(checkIndex).toBeLessThan(requestIndex);
  });

  it("upgrade route has error handling around billing.request()", () => {
    expect(upgradeContent).toContain("catch (err)");
    expect(upgradeContent).toContain("console.error");
    expect(upgradeContent).toContain('redirect("/app?billing=error")');
  });

  it("dashboard upgrade buttons point to /app/upgrade?plan=Pro", () => {
    const dashContent = fs.readFileSync(
      path.join(APP_DIR, "routes/app._index.tsx"),
      "utf-8"
    );
    const matches = dashContent.match(/url="\/app\/upgrade\?plan=Pro"/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(3);
  });
});
