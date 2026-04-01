/**
 * tests/bug-fixes.test.ts
 *
 * Regression tests for bugs fixed on feature/new-pricing.
 *
 * 1. No billing_plan references in application code (only tier)
 * 2. Unicode escape characters replaced with actual characters
 * 3. Upgrade buttons use useWebComponentClick refs, not onClick
 * 4. NavMenu navigation (Dashboard only)
 * 5. JSON-LD extension card visible in dashboard
 * 6. Pro tier scan decrement guard
 * 7. Component extraction from app._index.tsx
 * 8. Web component click hook
 * 9. (removed — scan history deleted)
 * 10. One-time $29 billing model (no $39, no /mo references)
 * 11. Email system removed (no resend, no email.server imports)
 * 12. JSON-LD deep link uses client_id, not extension UID
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

// ─── Web component click handling ───────────────────────────────────────────

describe("Web component click handling (useWebComponentClick)", () => {
  it("no <s-button onClick anywhere in app/", () => {
    let output = "";
    try {
      output = execFileSync(
        "grep",
        ["-rn", "<s-button.*onClick", "--include=*.tsx", APP_DIR],
        { encoding: "utf-8" }
      );
    } catch {
      output = "";
    }
    expect(output).toBe("");
  });

  it("useWebComponentClick hook exists and exports the function", () => {
    const hookPath = path.join(APP_DIR, "hooks/useWebComponentClick.ts");
    expect(fs.existsSync(hookPath)).toBe(true);
    const content = fs.readFileSync(hookPath, "utf-8");
    expect(content).toContain("export function useWebComponentClick");
    expect(content).toContain("addEventListener");
    expect(content).toContain("removeEventListener");
  });

  it("dashboard imports useWebComponentClick", () => {
    const dashContent = fs.readFileSync(
      path.join(APP_DIR, "routes/app._index.tsx"),
      "utf-8"
    );
    expect(dashContent).toContain("useWebComponentClick");
    expect(dashContent).toMatch(/import\s*\{[^}]*useWebComponentClick[^}]*\}/);
  });

  it("UpgradeCard uses useWebComponentClick for its button", () => {
    const content = fs.readFileSync(
      path.join(APP_DIR, "components/UpgradeCard.tsx"),
      "utf-8"
    );
    expect(content).toContain("useWebComponentClick");
    expect(content).toContain("ref={upgradeRef}");
    expect(content).not.toMatch(/<s-button.*onClick/);
  });

  it("UpgradeCard supports sidebar prop", () => {
    const content = fs.readFileSync(
      path.join(APP_DIR, "components/UpgradeCard.tsx"),
      "utf-8"
    );
    expect(content).toContain("sidebar");
    expect(content).toContain('slot: "aside"');
  });

  it("PolicyGenerationCard uses native <button> for policy generation (not <s-button>)", () => {
    const content = fs.readFileSync(
      path.join(APP_DIR, "components/PolicyGenerationCard.tsx"),
      "utf-8"
    );
    expect(content).toContain("policyFetcher.submit(");
    expect(content).toContain("Generate");
    // Should not use <s-button submit=""> for form submission
    expect(content).not.toContain('submit=""');
    expect(content).not.toContain("<s-button");
  });

  const dashContent = fs.readFileSync(
    path.join(APP_DIR, "routes/app._index.tsx"),
    "utf-8"
  );

  it("dashboard uses refs for all s-button elements", () => {
    // Should have ref= on s-button elements, not onClick
    const refMatches = dashContent.match(/ref={(?:rescanRef|upgradeRef\d|onboardingScanRef)}/g);
    expect(refMatches).not.toBeNull();
    expect(refMatches!.length).toBeGreaterThanOrEqual(6);
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

  it("upgrade buttons use refs, not url= attribute", () => {
    // There should be NO s-button elements with url="/app/upgrade..."
    expect(dashContent).not.toMatch(/url="\/app\/upgrade/);
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

  it("upgrade route uses relative returnUrl (not manually constructed admin URL)", () => {
    // The returnUrl must be a relative app path — the Shopify library converts it
    // to the full embedded admin URL. Manual construction causes route mismatches.
    expect(upgradeContent).toContain('returnUrl: "/app/billing/confirm"');
    // Must NOT manually build https://admin.shopify.com/store/... URL
    expect(upgradeContent).not.toContain("admin.shopify.com/store/");
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

// ─── Navigation ─────────────────────────────────────────────────────────────

describe("Navigation", () => {
  const appContent = fs.readFileSync(
    path.join(APP_DIR, "routes/app.tsx"),
    "utf-8"
  );

  it("app.tsx uses NavMenu from @shopify/app-bridge-react for navigation", () => {
    expect(appContent).toContain("NavMenu");
    expect(appContent).toMatch(/import\s*\{[^}]*NavMenu[^}]*\}\s*from\s*"@shopify\/app-bridge-react"/);
  });

  it("nav links are <a> tags inside <NavMenu>, not <s-link> or <s-app-nav>", () => {
    expect(appContent).toContain("<NavMenu>");
    expect(appContent).toContain('<a href="/app"');
    expect(appContent).not.toContain("<s-app-nav>");
    expect(appContent).not.toMatch(/<s-link[^>]*href="\/app/);
  });

  it("dashboard link has rel='home' attribute", () => {
    expect(appContent).toMatch(/<a\s+href="\/app"\s+rel="home"/);
  });

  it("scan history route does not exist (feature removed)", () => {
    const routeFile = path.join(APP_DIR, "routes/app.scan-history.tsx");
    expect(fs.existsSync(routeFile)).toBe(false);
  });

  it("no scan-history nav link in app.tsx", () => {
    expect(appContent).not.toContain("scan-history");
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

  it("JSON-LD section has one-click enable button with deep link", () => {
    expect(dashContent).toContain("Enable JSON-LD");
    expect(dashContent).toContain("activateAppId");
    // Deep link uses block filename (product-schema), not extension handle
    expect(dashContent).toContain("product-schema");
  });

  it("JSON-LD section is in the aside (visible to all tiers)", () => {
    expect(dashContent).toContain('slot="aside"');
    expect(dashContent).toContain("Free JSON-LD Structured Data");
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

// ─── Component extraction ────────────────────────────────────────────────────

describe("Component extraction from app._index.tsx", () => {
  const components = [
    "ScoreBanner",
    "KpiCards",
    "ScanProgressIndicator",
    "UpgradeCard",
    "PolicyGenerationCard",
    "AuditChecklist",
    "SecurityStatusAside",
  ];

  for (const name of components) {
    it(`${name}.tsx exists and exports a default function`, () => {
      const filePath = path.join(APP_DIR, `components/${name}.tsx`);
      expect(fs.existsSync(filePath)).toBe(true);
      const content = fs.readFileSync(filePath, "utf-8");
      expect(content).toMatch(/export\s+default\s+function\s+\w+/);
    });
  }

  it("app._index.tsx imports all extracted components", () => {
    const content = fs.readFileSync(
      path.join(APP_DIR, "routes/app._index.tsx"),
      "utf-8"
    );
    for (const name of components) {
      expect(content).toContain(`from "../components/${name}"`);
    }
  });

  it("app._index.tsx is under 1000 lines after extraction", () => {
    const content = fs.readFileSync(
      path.join(APP_DIR, "routes/app._index.tsx"),
      "utf-8"
    );
    const lineCount = content.split("\n").length;
    expect(lineCount).toBeLessThan(1000);
  });
});

// ─── Shared types and helpers ────────────────────────────────────────────────

describe("Shared types and helpers extraction", () => {
  it("app/lib/types.ts exists with core UI types", () => {
    const content = fs.readFileSync(
      path.join(APP_DIR, "lib/types.ts"),
      "utf-8"
    );
    expect(content).toContain("Severity");
    expect(content).toContain("Merchant");
    expect(content).toContain("Scan");
    expect(content).toContain("CheckResult");
    expect(content).toContain("ApiScanResponse");
  });

  it("app/lib/scan-helpers.ts exists with helper functions", () => {
    const content = fs.readFileSync(
      path.join(APP_DIR, "lib/scan-helpers.ts"),
      "utf-8"
    );
    expect(content).toContain("export function scoreColor");
    expect(content).toContain("export function sortChecks");
    expect(content).toContain("export function threatLabel");
    expect(content).toContain("export function fmtDate");
  });

  it("app/lib/constants.ts exists with color constants", () => {
    const content = fs.readFileSync(
      path.join(APP_DIR, "lib/constants.ts"),
      "utf-8"
    );
    expect(content).toContain("SCORE_GREEN");
    expect(content).toContain("BRAND_COLOR");
  });
});

// ─── JSON-LD extension structure ─────────────────────────────────────────────

describe("JSON-LD extension", () => {
  it("locales/en.default.json exists (fixes ENOENT during dev)", () => {
    const localesPath = path.resolve(
      ROOT_DIR,
      "extensions/json-ld-schema/locales/en.default.json"
    );
    expect(fs.existsSync(localesPath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(localesPath, "utf-8"));
    expect(content.name).toBeDefined();
  });

  it("extension uses body target for app embed", () => {
    const tomlPath = path.resolve(
      ROOT_DIR,
      "extensions/json-ld-schema/shopify.extension.toml"
    );
    const content = fs.readFileSync(tomlPath, "utf-8");
    expect(content).toContain('target = "body"');
  });
});

// ─── Hooks directory ─────────────────────────────────────────────────────────

describe("Hooks directory", () => {
  it("useWebComponentClick.ts exists", () => {
    expect(fs.existsSync(path.join(APP_DIR, "hooks/useWebComponentClick.ts"))).toBe(true);
  });

  it("useScanToast.ts removed (dead code — logic is inline in app._index.tsx)", () => {
    expect(fs.existsSync(path.join(APP_DIR, "hooks/useScanToast.ts"))).toBe(false);
  });
});

// ─── One-time $29 billing model ─────────────────────────────────────────────

describe("One-time $29 billing model", () => {
  it("no $39 references in app code", () => {
    let output = "";
    try {
      output = execFileSync(
        "grep",
        ["-rn", "\\$39\\|39\\.00", "--include=*.ts", "--include=*.tsx", APP_DIR],
        { encoding: "utf-8" }
      );
    } catch {
      output = "";
    }
    expect(output).toBe("");
  });

  it("no /mo pricing references in app code", () => {
    let output = "";
    try {
      output = execFileSync(
        "grep",
        ["-rn", "/mo", "--include=*.ts", "--include=*.tsx", APP_DIR],
        { encoding: "utf-8" }
      );
    } catch {
      output = "";
    }
    expect(output).toBe("");
  });

  it("billing config uses OneTime interval", () => {
    const content = fs.readFileSync(
      path.join(APP_DIR, "shopify.server.ts"),
      "utf-8"
    );
    expect(content).toContain("BillingInterval.OneTime");
    expect(content).not.toContain("BillingInterval.Every30Days");
  });

  it("billing config uses $29 amount", () => {
    const content = fs.readFileSync(
      path.join(APP_DIR, "shopify.server.ts"),
      "utf-8"
    );
    expect(content).toContain("amount: 29.00");
    expect(content).not.toContain("amount: 39.00");
  });

  it("no weekly automated monitoring in features", () => {
    const upgradeCard = fs.readFileSync(
      path.join(APP_DIR, "components/UpgradeCard.tsx"),
      "utf-8"
    );
    expect(upgradeCard).not.toContain("Weekly automated monitoring");
  });
});

// ─── Email system removed ───────────────────────────────────────────────────

describe("Email system removed", () => {
  it("no email.server.ts file exists", () => {
    expect(fs.existsSync(path.join(APP_DIR, "utils/email.server.ts"))).toBe(false);
  });

  it("no email-templates directory exists", () => {
    expect(fs.existsSync(path.join(APP_DIR, "utils/email-templates"))).toBe(false);
  });

  it("no resend imports in app code", () => {
    let output = "";
    try {
      output = execFileSync(
        "grep",
        ["-rn", "resend", "--include=*.ts", "--include=*.tsx", APP_DIR],
        { encoding: "utf-8" }
      );
    } catch {
      output = "";
    }
    expect(output).toBe("");
  });

  it("no email.server imports in route files", () => {
    let output = "";
    try {
      output = execFileSync(
        "grep",
        ["-rn", "email.server", "--include=*.ts", "--include=*.tsx", APP_DIR],
        { encoding: "utf-8" }
      );
    } catch {
      output = "";
    }
    expect(output).toBe("");
  });

  it("no plucore.com references in app code", () => {
    let output = "";
    try {
      output = execFileSync(
        "grep",
        ["-rn", "plucore\\.com", "--include=*.ts", "--include=*.tsx", APP_DIR],
        { encoding: "utf-8" }
      );
    } catch {
      output = "";
    }
    expect(output).toBe("");
  });
});

// ─── JSON-LD deep link uses client_id ───────────────────────────────────────

describe("JSON-LD deep link", () => {
  it("uses app client_id and block filename (not extension UID or extension handle) in activateAppId", () => {
    const content = fs.readFileSync(
      path.join(APP_DIR, "routes/app._index.tsx"),
      "utf-8"
    );
    // Should use client_id + block liquid filename (product-schema from blocks/product-schema.liquid)
    expect(content).toContain("activateAppId=071fc51ee1ef7f358cdaed5f95922498/product-schema");
    // Should NOT use the old extension UID
    expect(content).not.toContain("5f84566a-b42f-516d-7eec-00f7f6b2169e317fee21");
    // Should NOT use the extension handle (json-ld-schema) — must use block filename
    expect(content).not.toMatch(/activateAppId=.*\/json-ld-schema/);
  });
});
