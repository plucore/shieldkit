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

  it("PlanStatusCard uses useWebComponentClick for its upgrade button", () => {
    // v4 §7 replaced UpgradeCard with PlanStatusCard (two-state component:
    // paid coverage list vs free upgrade prompt). Same ref pattern.
    const content = fs.readFileSync(
      path.join(APP_DIR, "components/PlanStatusCard.tsx"),
      "utf-8"
    );
    expect(content).toContain("useWebComponentClick");
    expect(content).toContain("ref={upgradeRef}");
    expect(content).not.toMatch(/<s-button.*onClick/);
  });

  it("PlanStatusCard renders into the aside slot", () => {
    const content = fs.readFileSync(
      path.join(APP_DIR, "components/PlanStatusCard.tsx"),
      "utf-8"
    );
    expect(content).toContain('slot="aside"');
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
    // Should have ref= on s-button elements, not onClick. Count threshold
    // is the "are we using the pattern at all" sanity check; v4 §6 removed
    // the Monitoring→Recovery upsell banner which dropped one upgradeRef.
    const refMatches = dashContent.match(/ref={(?:rescanRef|upgradeRef\d|onboardingScanRef|managePlanRef|manageJsonLdRef)}/g);
    expect(refMatches).not.toBeNull();
    expect(refMatches!.length).toBeGreaterThanOrEqual(5);
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

  it("upgrade buttons use refs, not url= attribute", () => {
    // There should be NO s-button elements with url="/app/upgrade..."
    expect(dashContent).not.toMatch(/url="\/app\/upgrade/);
  });

  it("dashboard navigates to plain /app/upgrade (no ?plan= deep links under managed pricing)", () => {
    expect(dashContent).not.toMatch(/\/app\/upgrade\?plan=/);
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

  it("upgrade route bridges to managed pricing without calling Billing API", () => {
    expect(upgradeContent).not.toContain("billing.request");
    expect(upgradeContent).not.toContain("billing.check");
    expect(upgradeContent).toContain("getManagedPricingUrl");
    // Component must escape the embedded-app iframe to admin.shopify.com.
    // A server-side `redirect()` would target the iframe and be blocked
    // by Shopify admin's X-Frame-Options: DENY.
    expect(upgradeContent).toContain('window.open(url, "_top")');
    expect(upgradeContent).toContain('target="_top"');
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
    // Post-Fix-7 the URL is built by the centralised helper, not inlined.
    expect(dashContent).toContain("getJsonLdThemeEditorUrl");
    // The helper itself encodes the activateAppId + product-schema block.
    const helper = fs.readFileSync(
      path.join(APP_DIR, "lib/json-ld-deep-link.ts"),
      "utf-8"
    );
    expect(helper).toContain("activateAppId=");
    expect(helper).toContain("product-schema");
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

  it("app._index.tsx uses atomic decrement via RPC", () => {
    const content = fs.readFileSync(
      path.join(APP_DIR, "routes/app._index.tsx"),
      "utf-8"
    );
    expect(content).toContain("decrement_scan_quota");
  });

  it("api.scan.ts uses atomic decrement via RPC", () => {
    const content = fs.readFileSync(
      path.join(APP_DIR, "routes/api.scan.ts"),
      "utf-8"
    );
    expect(content).toContain("decrement_scan_quota");
  });
});

// ─── Component extraction ────────────────────────────────────────────────────

describe("Component extraction from app._index.tsx", () => {
  const components = [
    "ScoreBanner",
    "KpiCards",
    "ScanProgressIndicator",
    "PlanStatusCard",
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

// ─── Shopify Managed Pricing migration ──────────────────────────────────────

describe("Shopify Managed Pricing", () => {
  const plansPath = path.join(APP_DIR, "lib/billing/plans.ts");
  const plansContent = fs.readFileSync(plansPath, "utf-8");

  it("plans.ts exposes v3 plan names alongside grandfathered entries", () => {
    // v3 active plans — must be present for reconciliation of new subscribers.
    expect(plansContent).toContain("Monitoring");
    expect(plansContent).toContain("Recovery");
    // Grandfathered names — must be preserved so reconciliation for the 2
    // live Shield Max customers continues to work post-v3.
    expect(plansContent).toContain("Shield Pro");
    expect(plansContent).toContain("Shield Max");
    expect(plansContent).toContain("PLAN_NAME_TO_TIER");
  });

  it("plans.ts no longer registers a Billing API config", () => {
    expect(plansContent).not.toContain("SHOPIFY_BILLING_CONFIG");
    expect(plansContent).not.toContain("BillingConfigSubscriptionLineItemPlan");
    expect(plansContent).not.toContain("BillingInterval");
  });

  it("plans.ts exposes both interval-based and name-based cycle derivation", () => {
    // intervalToCycle is used on the Admin API path (APP_SUBSCRIPTIONS_UPDATE
    // webhook + billing.check() legacy fallback) where Shopify gives us the
    // AppPricingInterval enum.
    expect(plansContent).toContain("export function intervalToCycle");
    expect(plansContent).toContain("EVERY_30_DAYS");
    expect(plansContent).toContain("ANNUAL");
    // PLAN_NAME_TO_CYCLE is required on the Partner API path because the
    // Partner API's AppSubscription has no interval field — cycle must be
    // derived from the plan name. Only works because all four paid plan
    // names are distinct in the Partner Dashboard config.
    expect(plansContent).toContain("PLAN_NAME_TO_CYCLE");
  });

  it("intervalToCycle is case-insensitive (handles REST snake_case + GraphQL upper-snake)", () => {
    // The 2026-05-09 smoke test produced a webhook with `interval` in a
    // non-upper-snake casing; the strict check left billing_cycle NULL.
    // Helper must normalize before comparing.
    expect(plansContent).toMatch(/toUpperCase\(\)/);
  });

  it("plans.ts exports getManagedPricingUrl helper", () => {
    expect(plansContent).toContain("export function getManagedPricingUrl");
    expect(plansContent).toContain("SHOPIFY_APP_HANDLE");
    // Helper must throw loudly when SHOPIFY_APP_HANDLE is missing.
    expect(plansContent).toMatch(/throw\s+new\s+Error/);
  });

  it("webhook handler reads top-level interval (pre-April-28 supplementary channel)", () => {
    // Webhook is a supplementary reconciliation path until Shopify removes
    // APP_SUBSCRIPTIONS_UPDATE for managed-pricing apps on 2026-04-28.
    // Until then it derives cycle from the REST-shaped payload's top-level
    // `interval` field, via intervalToCycle().
    const content = fs.readFileSync(
      path.join(APP_DIR, "routes/webhooks.app_subscriptions.update.tsx"),
      "utf-8"
    );
    expect(content).toContain("intervalToCycle");
    expect(content).not.toContain("PLAN_NAME_TO_CYCLE");
    expect(content).toContain("interval?:");
    expect(content).not.toContain("lineItems");
  });

  it("billing-confirm loader uses Partner API only (legacy billing.check fallback removed)", () => {
    // Post 2026-05-27 sweep: Partner API is the only path. The legacy
    // billing.check() fallback was deleted because Shopify deprecated the
    // managed-pricing data on the Admin API endpoint; the dead fallback
    // was silently redirecting paying merchants to ?billing=cancelled when
    // Partner API returned status='unknown'.
    const content = fs.readFileSync(
      path.join(APP_DIR, "routes/app.billing.confirm.tsx"),
      "utf-8"
    );
    // Primary path assertions
    expect(content).toContain("getActiveSubscriptionByChargeId");
    expect(content).toContain("buildAppSubscriptionGid");
    expect(content).toContain('searchParams.get("charge_id")');
    expect(content).toMatch(/sub\.status === "active"/);
    // Legacy fallback fully removed
    expect(content).not.toMatch(/billing\.check\(/);
    expect(content).not.toContain("intervalToCycle");
    expect(content).not.toContain("pricingDetails");
    expect(content).not.toMatch(/REMOVE AFTER 2026-04-28/);
    // Unknown/pending now render a pending page, not a cancelled redirect
    expect(content).toContain('state: "pending"');
  });

  it("billing-confirm writes the full billing column set on Partner API success", () => {
    // Regression guard for the documented SLA columns in the loader docblock.
    // If any of these column writes goes missing, reconciliation will leave
    // the merchant in a half-promoted state.
    const content = fs.readFileSync(
      path.join(APP_DIR, "routes/app.billing.confirm.tsx"),
      "utf-8"
    );
    expect(content).toMatch(/tier:\s*sub\.tier/);
    expect(content).toMatch(/billing_cycle:\s*sub\.cycle/);
    expect(content).toMatch(/subscription_started_at:/);
    expect(content).toMatch(/shopify_subscription_id:\s*sub\.subscriptionGid/);
    expect(content).toMatch(/scans_remaining:\s*null/);
  });

  it("dashboard self-heal uses Partner API (post April 28 cliff)", () => {
    // Self-heal migrated from billing.check() (Admin API) to the Partner
    // API on 2026-05-14 ahead of Shopify removing managed-pricing data from
    // billing.check() on April 28. Cycle comes from the plan name via
    // partner-api.server.ts, not lineItems.pricingDetails.interval.
    const content = fs.readFileSync(
      path.join(APP_DIR, "routes/app._index.tsx"),
      "utf-8"
    );
    expect(content).toContain("getActiveSubscriptionByChargeId");
    expect(content).not.toMatch(/billing\.check\(/);
  });

  it("shopify.server.ts no longer registers `billing` config", () => {
    const content = fs.readFileSync(
      path.join(APP_DIR, "shopify.server.ts"),
      "utf-8"
    );
    expect(content).not.toContain("SHOPIFY_BILLING_CONFIG");
    expect(content).not.toMatch(/^\s*billing:\s/m);
  });

  it("/app/upgrade and /app/plan-switcher bridge to managed pricing via _top window.open", () => {
    for (const route of ["routes/app.upgrade.tsx", "routes/app.plan-switcher.tsx"]) {
      const content = fs.readFileSync(path.join(APP_DIR, route), "utf-8");
      expect(content).toContain("getManagedPricingUrl");
      expect(content).not.toContain("billing.request");
      expect(content).not.toContain("billing.cancel");
      // Must escape the iframe — a server-side `redirect()` would target
      // the embedded iframe and Shopify admin blocks iframe embedding.
      expect(content).toContain('window.open(url, "_top")');
    }
  });
});

// ─── No plucore.com refs in app code (carried forward from removed email block) ─

describe("Branding hygiene", () => {
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

// ─── JSON-LD activation — two-state model (v4) ──────────────────────────────
//
// The v3 verifier was removed because storefront fetches couldn't reach
// password-protected or pre-launch stores, producing false negatives for
// legitimate merchants. The compliance scan's `structured_data_json_ld`
// check is the authoritative source for whether the block is actually
// rendering. The dashboard UI flips merchants.json_ld_enabled on click and
// trusts that state.

describe("JSON-LD activation (v4 two-state model)", () => {
  it("enableJsonLd action flips json_ld_enabled=true on click", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "routes/app._index.tsx"),
      "utf-8"
    );
    expect(src).toContain('actionType === "enableJsonLd"');
    expect(src).toMatch(/json_ld_enabled:\s*true/);
  });

  it("verifier action handler and helper module are removed", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "routes/app._index.tsx"),
      "utf-8"
    );
    expect(src).not.toContain('actionType === "verifyJsonLdNow"');
    expect(src).not.toContain("verifyJsonLdForMerchant");
    expect(src).not.toContain("json-ld-verifier.server");
    expect(
      fs.existsSync(path.join(APP_DIR, "lib/json-ld-verifier.server.ts"))
    ).toBe(false);
    expect(
      fs.existsSync(path.join(APP_DIR, "routes/api.cron.verify-json-ld.ts"))
    ).toBe(false);
  });

  it("aside card is two-state (Active / Enable) — no pending/verify UI", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "routes/app._index.tsx"),
      "utf-8"
    );
    // On state.
    expect(src).toContain("JSON-LD Active");
    // The retired states must NOT appear anywhere in the file.
    expect(src).not.toContain("Verification pending");
    expect(src).not.toContain("Verify now");
    expect(src).not.toContain("Pending verification");
    // The card is driven by json_ld_enabled, not the deprecated columns.
    expect(src).toContain("merchant?.json_ld_enabled");
    expect(src).not.toContain("json_ld_verified_at");
    expect(src).not.toContain("json_ld_enable_clicked_at");
  });

  it("vercel.json no longer schedules the verifier cron", () => {
    const vercel = JSON.parse(
      fs.readFileSync(path.join(ROOT_DIR, "vercel.json"), "utf-8")
    );
    const cron = vercel.crons.find(
      (c: { path: string }) => c.path === "/api/cron/verify-json-ld"
    );
    expect(cron).toBeUndefined();
  });

  it("PlanStatusCard JSON-LD row is display-only (no Turn on action)", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "components/PlanStatusCard.tsx"),
      "utf-8"
    );
    // The competing "Turn on" action that lived on this card in v3 is gone.
    expect(src).not.toContain("Turn on");
    expect(src).not.toContain("onEnableJsonLd");
    expect(src).toContain("jsonLdEnabled");
  });
});

// ─── schema.sql cumulative state (Fix 10) ───────────────────────────────────

describe("schema.sql matches production cumulative state", () => {
  const schema = fs.readFileSync(
    path.join(ROOT_DIR, "supabase/schema.sql"),
    "utf-8"
  );

  it("tier CHECK admits v3 values + grandfathered shield/pro", () => {
    expect(schema).toMatch(
      /CHECK\s*\(\s*tier\s+IN\s*\(\s*'free',\s*'shield',\s*'pro',\s*'monitoring',\s*'recovery'/
    );
  });

  it("merchants has the v2 billing columns", () => {
    expect(schema).toContain("billing_cycle");
    expect(schema).toContain("subscription_started_at");
    expect(schema).toContain("shopify_subscription_id");
    expect(schema).toContain("scans_reset_at");
    expect(schema).toContain("pro_settings");
  });

  it("merchants still declares the JSON-LD columns (deprecated post-v4 but not dropped)", () => {
    // The verifier-era columns remain in the schema to match live DB shape.
    // They're marked DEPRECATED in the schema comments — no code path reads
    // or writes them as of v4. A future cleanup migration will drop them.
    expect(schema).toContain("json_ld_enabled");
    expect(schema).toContain("json_ld_enable_clicked_at");
    expect(schema).toContain("json_ld_verified_at");
    expect(schema).toContain("json_ld_verification_attempts");
    expect(schema).toContain("DEPRECATED (v4)");
  });

  it("merchants has the opportunistically-refreshed Shopify metadata columns", () => {
    expect(schema).toContain("shop_name");
    expect(schema).toContain("shop_owner_name");
    expect(schema).toContain("primary_domain");
    expect(schema).toContain("shop_metadata_refreshed_at");
    expect(schema).toContain("llms_txt_last_served_at");
  });

  it("declares the v2 tables (digest_emails, appeal_letters, schema_enrichments)", () => {
    expect(schema).toMatch(/CREATE TABLE IF NOT EXISTS digest_emails/);
    expect(schema).toMatch(/CREATE TABLE IF NOT EXISTS appeal_letters/);
    expect(schema).toMatch(/CREATE TABLE IF NOT EXISTS schema_enrichments/);
  });

  it("declares the phase 7 tables (enrichment_webhook_log, llms_txt_requests)", () => {
    expect(schema).toMatch(/CREATE TABLE IF NOT EXISTS enrichment_webhook_log/);
    expect(schema).toMatch(/CREATE TABLE IF NOT EXISTS llms_txt_requests/);
  });

  it("declares pending_scan_triggers with week_iso + payload + unique index (Fixes 8/9)", () => {
    expect(schema).toMatch(/pending_scan_triggers/);
    expect(schema).toMatch(/week_iso\s+TEXT/);
    expect(schema).toMatch(/payload\s+JSONB/);
    expect(schema).toMatch(/uq_pending_scan_triggers_week/);
  });

  it("declares webhook_failures table with unresolved partial index (Fix 4)", () => {
    expect(schema).toMatch(/CREATE TABLE IF NOT EXISTS webhook_failures/);
    expect(schema).toMatch(/idx_webhook_failures_unresolved/);
    expect(schema).toMatch(/WHERE resolved_at IS NULL/);
  });
});

// ─── GTIN enrichment off webhook hot path (Fix 9) ───────────────────────────

describe("GTIN enrichment off webhook hot path", () => {
  it("webhook handler enqueues instead of running inline", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "routes/webhooks.products.update.tsx"),
      "utf-8"
    );
    // Inline call site + SAFETY_BUDGET_MS race are gone.
    expect(src).not.toContain("SAFETY_BUDGET_MS");
    expect(src).not.toMatch(/Promise\.race\(\[enrichmentPromise/);
    expect(src).not.toContain("enrichProductMetafields");
    // New behaviour: enqueue trigger_type='enrichment' with payload.
    expect(src).toContain("trigger_type: \"enrichment\"");
    expect(src).toMatch(/payload:\s*\{/);
    expect(src).toContain("product_gid");
  });

  it("migration adds pending_scan_triggers.payload column", () => {
    const src = fs.readFileSync(
      path.join(
        ROOT_DIR,
        "supabase/migrations/20260527194459_enrichment_triggers.sql",
      ),
      "utf-8"
    );
    expect(src).toMatch(/ADD COLUMN IF NOT EXISTS payload JSONB/i);
    expect(src).toMatch(/trigger_type.*enrichment/i);
  });

  it("drainer routes enrichment triggers to enrichProductMetafields (v4: enrichment-only)", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "routes/api.cron.process-scan-triggers.ts"),
      "utf-8"
    );
    expect(src).toContain('r.trigger_type === "enrichment"');
    expect(src).toContain("enrichProductMetafields");
    expect(src).toContain("payload?.product_gid");
    // v4 dropped scan-class branches. The drainer should have NO call to
    // runComplianceScan from process-scan-triggers anymore.
    expect(src).not.toContain("runComplianceScan");
  });

  it("legacy non-enrichment trigger rows are advanced without scanning", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "routes/api.cron.process-scan-triggers.ts"),
      "utf-8"
    );
    expect(src).toContain("legacyRows");
    expect(src).toContain("legacy_skipped");
  });
});

// ─── ScoreBanner ongoing-value reassurance (v4 §8) ─────────────────────────

describe("ScoreBanner ongoing-value reassurance (v4 §8)", () => {
  it("renders a paid-clean reassurance line behind a strict gate", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "components/ScoreBanner.tsx"),
      "utf-8"
    );
    // Paid + score >= 80 + no critical issues.
    expect(src).toMatch(/hasPaidAccess\(merchant\.tier\)[\s\S]{0,300}score >= 80/);
    expect(src).toMatch(/critical_count[\s\S]{0,80}=== 0/);
    expect(src).toContain("Your store is clean.");
    expect(src).toContain("re-scan instantly");
  });
});

// ─── PlanStatusCard replaces UpgradeCard (v4 §7) ───────────────────────────

describe("PlanStatusCard two-state value box (v4 §7)", () => {
  it("component file exists with both state branches", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "components/PlanStatusCard.tsx"),
      "utf-8"
    );
    expect(src).toContain("PaidCoverageCard");
    expect(src).toContain("FreeUpgradeCard");
    expect(src).toContain("Your ShieldKit coverage");
    expect(src).toContain("Fix it now");
  });

  it("renders the canonical PAID_FEATURES + FREE_FEATURES from plans.ts", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "components/PlanStatusCard.tsx"),
      "utf-8"
    );
    expect(src).toContain("PAID_FEATURES");
    expect(src).toContain("FREE_FEATURES");
    expect(src).toContain("from \"../lib/billing/plans\"");
  });

  it("free state CTA includes the current price ($49/$390)", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "components/PlanStatusCard.tsx"),
      "utf-8"
    );
    // Price is interpolated from PLANS.monitoring_*; both values present
    expect(src).toContain("PLANS.monitoring_monthly.monthly");
    expect(src).toContain("PLANS.monitoring_annual.annual");
  });

  it("paid state JSON-LD row is display-only (no action) and reflects enabled state", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "components/PlanStatusCard.tsx"),
      "utf-8"
    );
    // v4 §1 collapsed the JSON-LD verifier into a single click=on flag, so
    // the PlanStatusCard row is now status-only (checked / off) — the actual
    // enable action lives only in the JSON-LD aside card.
    expect(src).toContain("jsonLdEnabled");
    expect(src).not.toContain("Turn on");
    expect(src).not.toContain("onEnableJsonLd");
    // Three row states: checked, locked, off.
    expect(src).toMatch(/state[:=]\s*"checked"/);
    expect(src).toMatch(/state[:=]\s*"locked"/);
    expect(src).toMatch(/state[:=]\s*"off"/);
  });

  it("dashboard wires PlanStatusCard at the top of the aside (above Security Status)", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "routes/app._index.tsx"),
      "utf-8"
    );
    const planIdx = src.indexOf("<PlanStatusCard");
    const securityIdx = src.indexOf("<SecurityStatusAside");
    expect(planIdx).toBeGreaterThan(0);
    expect(securityIdx).toBeGreaterThan(0);
    expect(planIdx).toBeLessThan(securityIdx);
  });

  it("old UpgradeCard.tsx is removed", () => {
    expect(
      fs.existsSync(path.join(APP_DIR, "components/UpgradeCard.tsx")),
    ).toBe(false);
  });
});

// ─── AI usage cap + policy self-consistency validator (v4 §5) ──────────────

describe("AI usage cap + policy validator (v4 §5)", () => {
  it("AI usage helper defines the 12/month cap and an atomic consume helper", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "lib/ai-usage.server.ts"),
      "utf-8"
    );
    expect(src).toContain("AI_MONTHLY_CAP = 12");
    expect(src).toContain("checkAndConsumeAiCredit");
    expect(src).toContain("consume_ai_credit");
    expect(src).toContain("windowResetIso");
  });

  it("policy-validator imports the same regexes the compliance checks use", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "lib/policy-validator.server.ts"),
      "utf-8"
    );
    expect(src).toContain("RETURN_WINDOW_RE");
    expect(src).toContain("ITEM_CONDITION_RE");
    expect(src).toContain("REFUND_METHOD_RE");
    expect(src).toContain("TIMELINE_RE");
    expect(src).toContain("COST_RE");
    expect(src).toContain("PLACEHOLDER_RE");
    // Imported from the shared constants file, NOT redefined locally.
    expect(src).toContain("from \"./checks/constants\"");
  });

  it("policy regexes are exported from checks/constants.ts and reused by check files", () => {
    const constants = fs.readFileSync(
      path.join(APP_DIR, "lib/checks/constants.ts"),
      "utf-8"
    );
    expect(constants).toMatch(/export const RETURN_WINDOW_RE\s*=/);
    expect(constants).toMatch(/export const TIMELINE_RE\s*=/);

    const refund = fs.readFileSync(
      path.join(APP_DIR, "lib/checks/refund-return-policy.server.ts"),
      "utf-8"
    );
    expect(refund).toContain("from \"./constants\"");

    const shipping = fs.readFileSync(
      path.join(APP_DIR, "lib/checks/shipping-policy.server.ts"),
      "utf-8"
    );
    expect(shipping).toContain("from \"./constants\"");
  });

  it("generatePolicy action consumes a credit + validates output + retries once", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "routes/app._index.tsx"),
      "utf-8"
    );
    expect(src).toContain("checkAndConsumeAiCredit(merchant.id)");
    expect(src).toContain("validateGeneratedPolicy");
    expect(src).toContain('"ai_cap_reached"');
    // Retry path appends an extra instruction to the second generatePolicy
    // call — the second call does NOT consume a second AI credit.
    expect(src).toMatch(/generatePolicy\(policyType, shopInfo, extra\)/);
  });

  it("appeal-letter action consumes a credit before hitting Anthropic", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "routes/app.appeal-letter.tsx"),
      "utf-8"
    );
    expect(src).toContain("checkAndConsumeAiCredit(merchant.id)");
    expect(src).toContain("AI_MONTHLY_CAP");
    // Cap check happens before generateAppealLetter is called.
    const capIdx = src.indexOf("checkAndConsumeAiCredit");
    const generateIdx = src.indexOf("generateAppealLetter(");
    expect(capIdx).toBeGreaterThan(0);
    expect(generateIdx).toBeGreaterThan(0);
    expect(capIdx).toBeLessThan(generateIdx);
  });

  it("appeal-letter persists generated letters and displays saved ones", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "routes/app.appeal-letter.tsx"),
      "utf-8"
    );
    // Persistence: the action INSERTs the generated body into appeal_letters.
    expect(src).toMatch(/\.from\("appeal_letters"\)\s*\.insert\(/);
    expect(src).toContain("generated_letter: letter");
    // Display fix: the loader fetches this merchant's saved letters (most
    // recent first) so they survive reload/navigation instead of vanishing
    // once the action response clears.
    expect(src).toMatch(
      /\.from\("appeal_letters"\)\s*\.select\("id, suspension_reason, generated_letter, created_at"\)/
    );
    expect(src).toMatch(/\.order\("created_at", \{ ascending: false \}\)/);
    // …and the component renders them at the bottom of the page.
    expect(src).toContain("Your saved appeal letters");
    // Body is rendered with line breaks preserved.
    expect(src).toContain("whiteSpace: \"pre-wrap\"");
  });

  it("migration adds ai_generations_used/reset_at columns + consume_ai_credit RPC", () => {
    const sql = fs.readFileSync(
      path.join(
        ROOT_DIR,
        "supabase/migrations/20260528121738_ai_usage_cap.sql",
      ),
      "utf-8",
    );
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS ai_generations_used/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS ai_generations_reset_at/);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION consume_ai_credit/);
    expect(sql).toMatch(/INTERVAL '30 days'/);
  });
});

// ─── Weekly auto-scan + digest infra removed in v4 §4 ──────────────────────

describe("Weekly auto-scan + digest infra removed (v4 §4)", () => {
  it("api.cron.weekly-scan.ts no longer exists", () => {
    expect(
      fs.existsSync(path.join(APP_DIR, "routes/api.cron.weekly-scan.ts")),
    ).toBe(false);
  });

  it("api.cron.weekly-digest.ts no longer exists", () => {
    expect(
      fs.existsSync(path.join(APP_DIR, "routes/api.cron.weekly-digest.ts")),
    ).toBe(false);
  });

  it("lib/emails/weekly-digest.ts no longer exists", () => {
    expect(
      fs.existsSync(path.join(APP_DIR, "lib/emails/weekly-digest.ts")),
    ).toBe(false);
  });

  it("lib/emails/send.server.ts no longer exists (only consumer was digest)", () => {
    expect(
      fs.existsSync(path.join(APP_DIR, "lib/emails/send.server.ts")),
    ).toBe(false);
  });

  it("vercel.json has no weekly-scan or weekly-digest cron entries", () => {
    const vercel = JSON.parse(
      fs.readFileSync(path.join(ROOT_DIR, "vercel.json"), "utf-8"),
    );
    const paths = (vercel.crons ?? []).map((c: { path: string }) => c.path);
    expect(paths).not.toContain("/api/cron/weekly-scan");
    expect(paths).not.toContain("/api/cron/weekly-digest");
    expect(paths).not.toContain("/api/cron/monthly-reset");
  });

  it("webhooks.themes.update.tsx is a no-op ACK", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "routes/webhooks.themes.update.tsx"),
      "utf-8"
    );
    expect(src).toContain("authenticate.webhook");
    expect(src).toContain("return new Response()");
    // No more enqueue, no helper imports, no DB writes from this handler.
    expect(src).not.toContain("pending_scan_triggers");
    expect(src).not.toContain("hasPaidAccess");
    expect(src).not.toContain("hasMonitoringAccess");
  });
});

// ─── Dashboard self-heal off render path (Fix 6) ────────────────────────────

describe("Dashboard self-heal action (Fix 6)", () => {
  it("loader no longer calls Partner API synchronously", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "routes/app._index.tsx"),
      "utf-8"
    );
    // The action handler still uses getActiveSubscriptionByChargeId, but
    // the loader's pre-fix inline call site is gone. Assert by checking
    // that the loader's docstring no longer references the inline block,
    // and that the action handler exists.
    expect(src).toContain('actionType === "selfHealBilling"');
    expect(src).toContain("moved off the critical render path");
  });

  it("client useEffect fires selfHealBilling once on mount for paid merchants", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "routes/app._index.tsx"),
      "utf-8"
    );
    expect(src).toContain("selfHealFiredRef");
    expect(src).toMatch(/selfHealFetcher\.submit\(\s*\{\s*action:\s*"selfHealBilling"/);
    // Skip for free tier — defensive against firing where it'd no-op.
    expect(src).toMatch(/merchant\.tier === "free"[\s\S]*?return/);
  });

  it("self-heal action never demotes on uncertainty", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "routes/app._index.tsx"),
      "utf-8"
    );
    // Unknown status → no DB write, returns healed:false.
    expect(src).toMatch(/sub\.status === "unknown"[\s\S]*?leaving DB untouched/);
    // Write only on active.
    expect(src).toMatch(/sub\.status === "active"[\s\S]*?supabase[\s\S]*?\.update\(/);
  });

  it("on healed:true the dashboard revalidates loader", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "routes/app._index.tsx"),
      "utf-8"
    );
    expect(src).toMatch(/selfHealFetcher\.data\.healed[\s\S]*?revalidator\.revalidate/);
  });
});

// ─── Onboarding wizard 4-step + 10→12 (Fix 5) ───────────────────────────────

describe("Onboarding wizard (v4 — 3 steps, no JSON-LD)", () => {
  it("wizard has exactly 3 numbered steps", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "routes/app._index.tsx"),
      "utf-8"
    );
    expect(src).toMatch(/num:\s*1\b/);
    expect(src).toMatch(/num:\s*2\b/);
    expect(src).toMatch(/num:\s*3\b/);
    expect(src).not.toMatch(/num:\s*4\b/);
  });

  it("wizard does NOT include the JSON-LD enablement step", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "routes/app._index.tsx"),
      "utf-8"
    );
    // JSON-LD enablement now lives only on the home dashboard aside card,
    // not in onboarding — one clean primary CTA per first-time view.
    expect(src).not.toContain("Enable Free Structured Data");
    expect(src).not.toContain("Enable JSON-LD on my theme");
    expect(src).not.toContain("isJsonLdStep");
  });

  it("no hard-coded '10-point' references remain in app._index.tsx", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "routes/app._index.tsx"),
      "utf-8"
    );
    expect(src).not.toContain("10-point");
    expect(src).toContain("12-point");
  });
});

// ─── Uninstall webhook reliability + reconciler (Fix 4) ─────────────────────

describe("Uninstall webhook reliability", () => {
  it("uninstall webhook inserts webhook_failures row on Supabase write failure", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "routes/webhooks.app.uninstalled.tsx"),
      "utf-8"
    );
    expect(src).toContain("recordWebhookFailure");
    expect(src).toContain("webhook_failures");
    // Must wrap the failure insert in its own try/catch (insertion failure
    // must NEVER break the webhook ACK upstream).
    expect(src).toMatch(/try\s*\{[\s\S]*webhook_failures[\s\S]*\}\s*catch/);
  });

  it("uninstall webhook always returns 200 (preserved contract)", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "routes/webhooks.app.uninstalled.tsx"),
      "utf-8"
    );
    expect(src).toContain("return new Response()");
    expect(src).not.toMatch(/throw\s+new\s+/);
  });

  it("webhook_failures migration creates table + unresolved index", () => {
    const src = fs.readFileSync(
      path.join(ROOT_DIR, "supabase/migrations/20260527193253_webhook_failures.sql"),
      "utf-8"
    );
    expect(src).toMatch(/CREATE TABLE IF NOT EXISTS webhook_failures/i);
    expect(src).toMatch(/idx_webhook_failures_unresolved/i);
    expect(src).toMatch(/WHERE resolved_at IS NULL/i);
  });

  it("reconcile-installs cron probes Shopify Admin API + back-fills uninstalled_at", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "routes/api.cron.reconcile-installs.ts"),
      "utf-8"
    );
    expect(src).toContain("CRON_SECRET");
    expect(src).toContain("createAdminClient");
    // Treats 401/403 from Shopify as definitive uninstall signal.
    expect(src).toMatch(/HTTP 401/);
    // Audit row insert into webhook_failures with resolved_at set.
    expect(src).toContain("webhook_failures");
    expect(src).toMatch(/resolved_at:\s*nowIso/);
  });

  it("vercel.json schedules reconcile-installs daily at 03:00 UTC", () => {
    const vercel = JSON.parse(
      fs.readFileSync(path.join(ROOT_DIR, "vercel.json"), "utf-8")
    );
    const cron = vercel.crons.find(
      (c: { path: string }) => c.path === "/api/cron/reconcile-installs"
    );
    expect(cron).toBeDefined();
    expect(cron.schedule).toBe("0 3 * * *");
  });
});

// ─── Policy detection: Page-hosted fallback ─────────────────────────────────

describe("Policy detection Page fallback", () => {
  it("refund check accepts a Page when no Settings → Policies entry exists", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "lib/checks/refund-return-policy.server.ts"),
      "utf-8"
    );
    expect(src).toContain("findPolicyPage");
    expect(src).toMatch(/REFUND_PAGE_PATTERN\s*=\s*\/refund\|return\/i/);
    expect(src).toContain('"Policy detected on page, not in Settings → Policies"');
    // checkRefundPolicy must accept pages as a second arg
    expect(src).toMatch(/export function checkRefundPolicy\(\s*policies:[^,]+,\s*pages/);
  });

  it("shipping check accepts a Page when no Settings → Policies entry exists", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "lib/checks/shipping-policy.server.ts"),
      "utf-8"
    );
    expect(src).toContain("findPolicyPage");
    expect(src).toMatch(/SHIPPING_PAGE_PATTERN\s*=\s*\/shipping\|delivery\/i/);
    expect(src).toMatch(/export function checkShippingPolicy\(\s*policies:[^,]+,\s*pages/);
  });

  it("privacy_and_terms searches privacy and terms independently in Pages", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "lib/checks/privacy-and-terms.server.ts"),
      "utf-8"
    );
    expect(src).toContain("findPolicyPage");
    expect(src).toMatch(/PRIVACY_PAGE_PATTERN\s*=\s*\/privacy\/i/);
    expect(src).toMatch(/TERMS_PAGE_PATTERN\s*=\s*\/terms\|tos\|conditions\/i/);
    expect(src).toMatch(/export function checkPrivacyAndTerms\(\s*policies:[^,]+,\s*pages/);
  });

  it("orchestrator passes pages into all three policy checks", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "lib/checks/index.server.ts"),
      "utf-8"
    );
    expect(src).toMatch(/checkRefundPolicy\(shopPolicies,\s*pages\)/);
    expect(src).toMatch(/checkShippingPolicy\(shopPolicies,\s*pages\)/);
    expect(src).toMatch(/checkPrivacyAndTerms\(shopPolicies,\s*pages\)/);
  });

  it("findPolicyPage helper is exported from helpers.server.ts", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "lib/checks/helpers.server.ts"),
      "utf-8"
    );
    expect(src).toContain("export function findPolicyPage");
  });
});

// ─── JSON-LD deep link uses client_id ───────────────────────────────────────

describe("JSON-LD deep link", () => {
  it("app._index.tsx uses the centralised getJsonLdThemeEditorUrl helper", () => {
    const content = fs.readFileSync(
      path.join(APP_DIR, "routes/app._index.tsx"),
      "utf-8"
    );
    // Post-Fix-7: literal client_id removed; uses helper instead.
    expect(content).toContain("getJsonLdThemeEditorUrl");
    expect(content).not.toContain("071fc51ee1ef7f358cdaed5f95922498");
  });

  it("helper accepts apiKey as a parameter (no process.env read — Vite doesn't expose it client-side)", () => {
    const helper = fs.readFileSync(
      path.join(APP_DIR, "lib/json-ld-deep-link.ts"),
      "utf-8"
    );
    // The helper is imported by client-side code in app._index.tsx; reading
    // process.env inside it throws in the browser. Server-side loaders read
    // the env and pass it through useLoaderData. The docstring may mention
    // process.env as a callsite hint — only the executable read is forbidden.
    const codeWithoutComments = helper
      .replace(/\/\*[\s\S]*?\*\//g, "") // strip block comments
      .replace(/\/\/.*$/gm, ""); // strip line comments
    expect(codeWithoutComments).not.toMatch(/process\.env\.SHOPIFY_API_KEY/);
    expect(helper).toMatch(/apiKey:\s*string/);
    expect(helper).toContain("activateAppId=");
    expect(helper).toContain("getJsonLdThemeEditorUrl");
    // Must throw on missing apiKey rather than silently emit a broken URL.
    expect(helper).toMatch(/throw\s+new\s+Error/);
  });

  it("loader threads SHOPIFY_API_KEY through to the component", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "routes/app._index.tsx"),
      "utf-8"
    );
    // Loader reads the env once, server-side, and returns it as
    // shopifyApiKey so the component can pass it into the helper.
    expect(src).toContain("process.env.SHOPIFY_API_KEY");
    expect(src).toContain("shopifyApiKey");
    // Every call site passes shopifyApiKey as the third arg.
    expect(src).toMatch(/getJsonLdThemeEditorUrl\([^)]*shopifyApiKey\)/);
  });

  it("never emits the old extension UID or extension handle", () => {
    const content = fs.readFileSync(
      path.join(APP_DIR, "routes/app._index.tsx"),
      "utf-8"
    );
    expect(content).not.toContain("5f84566a-b42f-516d-7eec-00f7f6b2169e317fee21");
    expect(content).not.toMatch(/activateAppId=.*\/json-ld-schema/);
  });
});

// ─── afterAuth scans_remaining behavior (cleanup batch §6) ──────────────────

describe("afterAuth preserves scans_remaining on reinstall", () => {
  it("does not include scans_remaining in the upsert payload", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "shopify.server.ts"),
      "utf-8"
    );
    // Adding scans_remaining to the upsert object would refund a free scan
    // on every reauth — that's a free-tier abuse path. The behavior we
    // want: INSERT uses DB DEFAULT 1; UPDATE leaves the existing value alone.
    const upsertBlock = src.slice(
      src.indexOf(".upsert("),
      src.indexOf(", { onConflict")
    );
    expect(upsertBlock).not.toContain("scans_remaining");
  });

  it("documents the intentional preserve-on-reinstall behavior", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "shopify.server.ts"),
      "utf-8"
    );
    expect(src).toContain("free-scan farming");
  });
});

// ─── GTIN Auto-Fill manual button feedback (cleanup batch §7) ───────────────

describe("GTIN Auto-Fill button surfaces zero-work outcome", () => {
  it("renders an info banner when the action returns ok=true and succeeded=0", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "routes/app.gtin-fill.tsx"),
      "utf-8"
    );
    // Pre-fix: the success banner was gated on `succeeded > 0`, so when the
    // action returned ok=true with 0 candidates (e.g. test store with no
    // SKUs/barcodes/vendor) the click produced no UI change — looked broken.
    // The banner now diagnoses *why* nothing was written (no SKU/barcode to
    // derive identifiers from) instead of the old passive "Nothing to write".
    expect(src).toContain("These products need a SKU or barcode first");
    expect(src).toMatch(/actionData\.succeeded\s*===\s*0/);
  });

  it("Auto-Fill button is wired via useWebComponentClick (s-button needs native click)", () => {
    const src = fs.readFileSync(
      path.join(APP_DIR, "routes/app.gtin-fill.tsx"),
      "utf-8"
    );
    expect(src).toContain("useWebComponentClick");
    expect(src).toContain("enrichRef");
    expect(src).toMatch(/ref=\{enrichRef\}/);
  });
});

// ─── FK cascades for GDPR shop/redact (cleanup batch §8) ────────────────────

describe("Child FKs to merchants all CASCADE for GDPR shop/redact", () => {
  it("migration drops + recreates the three NO ACTION FKs with CASCADE", () => {
    const src = fs.readFileSync(
      path.join(
        ROOT_DIR,
        "supabase/migrations/20260528160000_cascade_fks_for_shop_redact.sql",
      ),
      "utf-8",
    );
    for (const tbl of ["enrichment_webhook_log", "llms_txt_requests", "pending_scan_triggers"]) {
      expect(src).toMatch(new RegExp(`ALTER TABLE\\s+${tbl}`));
      expect(src).toMatch(
        new RegExp(`${tbl}_merchant_id_fkey[\\s\\S]*?ON DELETE CASCADE`),
      );
    }
  });

  it("schema.sql declares CASCADE on the three formerly-NO-ACTION tables", () => {
    const schema = fs.readFileSync(
      path.join(ROOT_DIR, "supabase/schema.sql"),
      "utf-8",
    );
    // Each of the three child tables now declares the FK with CASCADE.
    expect(schema).toMatch(
      /CREATE TABLE IF NOT EXISTS enrichment_webhook_log[\s\S]*?REFERENCES merchants\(id\) ON DELETE CASCADE/,
    );
    expect(schema).toMatch(
      /CREATE TABLE IF NOT EXISTS llms_txt_requests[\s\S]*?REFERENCES merchants\(id\) ON DELETE CASCADE/,
    );
    expect(schema).toMatch(
      /CREATE TABLE IF NOT EXISTS pending_scan_triggers[\s\S]*?REFERENCES merchants\(id\) ON DELETE CASCADE/,
    );
  });
});
