/**
 * tests/bug-fixes.test.ts
 *
 * Regression tests for bugs fixed on feature/new-pricing.
 *
 * 1. No billing_plan references in application code (only tier)
 * 2. Unicode escape characters replaced with actual characters
 * 3. Upgrade buttons use React Router navigate(), not url= attributes
 * 4. Scan History route exports + NavMenu navigation
 * 5. JSON-LD extension card visible in dashboard
 * 6. Pro tier scan decrement guard
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const APP_DIR = path.resolve(__dirname, "../app");
const ROOT_DIR = path.resolve(__dirname, "..");

// ─── billing_plan vs tier consistency ────────────────────────────────────────

describe("billing_plan vs tier consistency", () => {
  it("no application code references billing_plan", () => {
    // Search all .ts/.tsx files in app/ for "billing_plan"
    let output = "";
    try {
      output = execFileSync(
        "grep",
        ["-rn", "billing_plan", "--include=*.ts", "--include=*.tsx", APP_DIR],
        { encoding: "utf-8" }
      );
    } catch {
      output = "";
    }
    expect(output).toBe("");
  });

  it("no SQL files reference billing_plan", () => {
    let output = "";
    try {
      output = execFileSync(
        "grep",
        ["-rn", "billing_plan", "--include=*.sql", ROOT_DIR],
        { encoding: "utf-8" }
      );
    } catch {
      output = "";
    }
    expect(output).toBe("");
  });
});

// ─── Unicode escape characters ───────────────────────────────────────────────

describe("Unicode escape characters", () => {
  it("no raw \\uXXXX escape sequences in any .ts/.tsx file under app/", () => {
    let output = "";
    try {
      output = execFileSync(
        "grep",
        ["-rn", "\\\\u[0-9a-fA-F]\\{4\\}", "--include=*.ts", "--include=*.tsx", APP_DIR],
        { encoding: "utf-8" }
      );
    } catch {
      output = "";
    }
    expect(output).toBe("");
  });
});

// ─── Upgrade button navigation ───────────────────────────────────────────────

describe("Upgrade button uses React Router navigation", () => {
  const dashContent = fs.readFileSync(
    path.join(APP_DIR, "routes/app._index.tsx"),
    "utf-8"
  );

  it("dashboard imports useNavigate from react-router", () => {
    expect(dashContent).toContain("useNavigate");
    expect(dashContent).toMatch(/import\s*\{[^}]*useNavigate[^}]*\}\s*from\s*"react-router"/);
  });

  it("dashboard defines navigateToUpgrade using useNavigate", () => {
    expect(dashContent).toContain("navigateToUpgrade");
    expect(dashContent).toContain('navigate("/app/upgrade?plan=Pro")');
  });

  it("upgrade buttons use onClick, not url= attribute", () => {
    // There should be NO s-button elements with url="/app/upgrade..."
    expect(dashContent).not.toMatch(/url="\/app\/upgrade/);
    // There should be onClick={navigateToUpgrade} references
    const onClickMatches = dashContent.match(/onClick={navigateToUpgrade}/g);
    expect(onClickMatches).not.toBeNull();
    expect(onClickMatches!.length).toBeGreaterThanOrEqual(4);
  });

  const upgradeContent = fs.readFileSync(
    path.join(APP_DIR, "routes/app.upgrade.tsx"),
    "utf-8"
  );

  it("upgrade route exports a loader", () => {
    expect(upgradeContent).toMatch(/export\s+const\s+loader\s*=/);
  });

  it("upgrade route exports an ErrorBoundary", () => {
    expect(upgradeContent).toMatch(/export\s+function\s+ErrorBoundary/);
  });

  it("upgrade route plan name matches shopify.server.ts PLAN_PRO", () => {
    expect(upgradeContent).toContain("PLAN_PRO");
    const shopifyContent = fs.readFileSync(
      path.join(APP_DIR, "shopify.server.ts"),
      "utf-8"
    );
    expect(shopifyContent).toMatch(/PLAN_PRO\s*=\s*"Pro"/);
  });

  it("upgrade route checks existing subscription before billing.request()", () => {
    const checkIndex = upgradeContent.indexOf("await billing.check(");
    const requestIndex = upgradeContent.indexOf("await billing.request(");
    expect(checkIndex).toBeGreaterThan(-1);
    expect(requestIndex).toBeGreaterThan(-1);
    expect(checkIndex).toBeLessThan(requestIndex);
  });

  it("upgrade route has console.error at every failure point", () => {
    expect(upgradeContent).toContain('console.error("[upgrade] billing.check()');
    expect(upgradeContent).toContain('console.error("[upgrade] billing.request()');
  });
});

// ─── Scan History route and navigation ───────────────────────────────────────

describe("Scan History navigation", () => {
  const scanHistoryContent = fs.readFileSync(
    path.join(APP_DIR, "routes/app.scan-history.tsx"),
    "utf-8"
  );
  const appContent = fs.readFileSync(
    path.join(APP_DIR, "routes/app.tsx"),
    "utf-8"
  );

  it("app.scan-history.tsx exports a default component", () => {
    expect(scanHistoryContent).toMatch(/export\s+default\s+function\s+\w+/);
  });

  it("app.scan-history.tsx exports a loader function", () => {
    expect(scanHistoryContent).toMatch(/export\s+const\s+loader\s*=/);
  });

  it("app.tsx uses NavMenu from @shopify/app-bridge-react for navigation", () => {
    expect(appContent).toContain("NavMenu");
    expect(appContent).toMatch(/import\s*\{[^}]*NavMenu[^}]*\}\s*from\s*"@shopify\/app-bridge-react"/);
  });

  it("nav links are <a> tags inside <NavMenu>, not <s-link> or <s-app-nav>", () => {
    expect(appContent).toContain("<NavMenu>");
    expect(appContent).toContain('<a href="/app"');
    expect(appContent).toContain('<a href="/app/scan-history"');
    expect(appContent).not.toContain("<s-app-nav>");
    expect(appContent).not.toMatch(/<s-link[^>]*href="\/app/);
  });

  it("dashboard link has rel='home' attribute", () => {
    expect(appContent).toMatch(/<a\s+href="\/app"\s+rel="home"/);
  });

  it("nav link path matches scan history route file convention", () => {
    // app.scan-history.tsx → /app/scan-history via React Router file-based routing
    const routeFile = path.join(APP_DIR, "routes/app.scan-history.tsx");
    expect(fs.existsSync(routeFile)).toBe(true);
    expect(appContent).toContain('href="/app/scan-history"');
  });
});

// ─── JSON-LD extension visibility ────────────────────────────────────────────

describe("JSON-LD extension visibility", () => {
  const dashContent = fs.readFileSync(
    path.join(APP_DIR, "routes/app._index.tsx"),
    "utf-8"
  );

  it("dashboard has a JSON-LD extension section", () => {
    expect(dashContent).toContain("Free JSON-LD Structured Data");
  });

  it("JSON-LD section explains how to enable the extension", () => {
    expect(dashContent).toContain("Customize");
    expect(dashContent).toContain("Add app block");
    expect(dashContent).toContain("ShieldKit Product Schema");
  });

  it("JSON-LD section is in the aside (visible to all tiers)", () => {
    // The section should use slot="aside" to appear in the sidebar
    expect(dashContent).toContain('slot="aside" heading="Free JSON-LD Structured Data"');
  });
});

// ─── Pro tier scan decrement logic ───────────────────────────────────────────

describe("Scan decrement guard", () => {
  function shouldDecrement(scansRemaining: number | null | undefined): boolean {
    return typeof scansRemaining === "number" && scansRemaining > 0;
  }

  it("does NOT decrement when null (Pro tier)", () => {
    expect(shouldDecrement(null)).toBe(false);
  });

  it("decrements when scans_remaining is 1", () => {
    expect(shouldDecrement(1)).toBe(true);
  });

  it("does NOT decrement when 0 (exhausted)", () => {
    expect(shouldDecrement(0)).toBe(false);
  });

  it("does NOT decrement when undefined", () => {
    expect(shouldDecrement(undefined)).toBe(false);
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
