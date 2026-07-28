/**
 * tests/block3-install-events.test.ts
 *
 * install_events is the ONLY durable churn record this app has. Everything else
 * that could record an uninstall is hard-deleted 48h later by shop/redact — the
 * merchants row itself plus all 7 CASCADE children.
 *
 * Two properties are load-bearing and both are asserted behaviourally here:
 *
 *   1. NO FOREIGN KEY. An FK on merchant_id would put the ledger back inside the
 *      exact cascade it exists to survive. This is asserted against the migration
 *      text AND against the live-schema doc; the live DB was verified separately
 *      (foreign_keys = 0).
 *
 *   2. THE REDACT ROW IS WRITTEN BEFORE THE DELETE. After the DELETE the tier is
 *      unknowable — the row is gone. A ledger write placed after it would record
 *      tier=null for every redacted merchant, which is precisely the information
 *      the ledger exists to preserve.
 *
 * Plus the non-negotiable safety property: a ledger failure must never break an
 * OAuth completion or a webhook ACK. Shopify does not retry shop/redact, so a
 * throw there is a permanent, silent GDPR gap.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");

// ─── Mutable fixtures ───────────────────────────────────────────────────────
let insertMode: "ok" | "error" | "throw" = "ok";
let insertedRows: Array<Record<string, unknown>> = [];
let sentryCaptures: unknown[] = [];

vi.mock("../app/supabase.server", () => {
  const from = (table: string) => ({
    insert: async (payload: Record<string, unknown>) => {
      if (table !== "install_events") return { error: null };
      if (insertMode === "throw") throw new Error("connection reset");
      insertedRows.push(payload);
      return insertMode === "error"
        ? { error: { message: 'relation "install_events" does not exist' } }
        : { error: null };
    },
  });
  return { supabase: { from } };
});

vi.mock("../app/lib/sentry.server", () => ({
  sentry: {
    captureException: (e: unknown) => sentryCaptures.push(e),
    addBreadcrumb: () => {},
    captureMessage: () => {},
  },
}));

const { recordInstallEvent } = await import("../app/lib/install-events.server");

beforeEach(() => {
  insertMode = "ok";
  insertedRows = [];
  sentryCaptures = [];
});

// ────────────────────────────────────────────────────────────────────────────
describe("recordInstallEvent writes the row", () => {
  it("maps every field onto the ledger row", async () => {
    await recordInstallEvent({
      shopDomain: "example.myshopify.com",
      eventType: "uninstall",
      tier: "monitoring",
      merchantId: "11111111-2222-3333-4444-555555555555",
      metadata: { billing_cycle: "monthly" },
    });
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toEqual({
      shop_domain: "example.myshopify.com",
      event_type: "uninstall",
      tier: "monitoring",
      merchant_id: "11111111-2222-3333-4444-555555555555",
      metadata: { billing_cycle: "monthly" },
    });
  });

  it("nulls tier/merchant_id rather than omitting them when unknown", async () => {
    // A redact for a shop whose merchant row is already gone must still record.
    await recordInstallEvent({ shopDomain: "gone.myshopify.com", eventType: "redact" });
    expect(insertedRows[0]).toMatchObject({ tier: null, merchant_id: null, metadata: {} });
  });

  it("accepts all three lifecycle types the CHECK constraint allows", async () => {
    for (const t of ["install", "uninstall", "redact"] as const) {
      await recordInstallEvent({ shopDomain: "s.myshopify.com", eventType: t });
    }
    expect(insertedRows.map((r) => r.event_type)).toEqual(["install", "uninstall", "redact"]);
  });
});

describe("a ledger failure can never break the caller", () => {
  it("swallows a Postgres error and captures it", async () => {
    insertMode = "error";
    await expect(
      recordInstallEvent({ shopDomain: "s.myshopify.com", eventType: "uninstall" }),
    ).resolves.toBeUndefined();
    expect(sentryCaptures).toHaveLength(1);
  });

  it("swallows a client-level throw and captures it", async () => {
    insertMode = "throw";
    await expect(
      recordInstallEvent({ shopDomain: "s.myshopify.com", eventType: "uninstall" }),
    ).resolves.toBeUndefined();
    expect(sentryCaptures).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe("THE ONE RULE: no foreign key to merchants", () => {
  const migration = read("supabase", "migrations", "20260728120000_install_events.sql");
  // Both the header prose and the COMMENT ON strings deliberately quote
  // "REFERENCES merchants(id) ON DELETE CASCADE" / "NO foreign key" when
  // explaining the rule, so the assertion must target the CREATE TABLE body
  // alone. Extract it, with `--` comment lines stripped.
  const createStart = migration.indexOf("CREATE TABLE IF NOT EXISTS install_events");
  const ddl = migration
    .slice(createStart, migration.indexOf("\n);", createStart))
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");

  it("the CREATE TABLE body declares no REFERENCES anywhere", () => {
    // Not a style preference. Every one of the 7 existing child tables has
    // `REFERENCES merchants(id) ON DELETE CASCADE`, which is exactly why none of
    // them survived to record any churn.
    expect(createStart).toBeGreaterThan(-1);
    // Guard the extraction itself, so this test can't pass on an empty string.
    expect(ddl).toMatch(/shop_domain\s+TEXT NOT NULL/);
    expect(ddl).not.toMatch(/REFERENCES/i);
    expect(ddl).not.toMatch(/FOREIGN KEY/i);
    expect(ddl).not.toMatch(/CASCADE/i);
  });

  it("merchant_id is a bare UUID column", () => {
    expect(migration).toMatch(/merchant_id\s+UUID\s*,/);
  });

  it("the prohibition is documented in the table comment, where a migration author will see it", () => {
    // A future "tidy up the schema" migration is the realistic failure mode.
    expect(migration).toMatch(/COMMENT ON TABLE install_events/);
    expect(migration).toMatch(/NO foreign key/i);
    expect(migration).toMatch(/COMMENT ON COLUMN install_events\.merchant_id/);
  });

  it("the server module repeats the rule", () => {
    expect(read("app", "lib", "install-events.server.ts")).toMatch(
      /NO FOREIGN KEY TO merchants/i,
    );
  });

  it("stores no PII — it outlives a GDPR redact by design", () => {
    // shop_domain + tier are business identifiers; email/owner/address are not.
    for (const col of ["email", "owner_name", "contact_email", "billing_address"]) {
      expect(migration).not.toMatch(new RegExp(`^\\s+${col}\\s`, "mi"));
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe("all three call sites are wired", () => {
  it("afterAuth records an install", () => {
    const src = read("app", "shopify.server.ts");
    expect(src).toMatch(/import \{ recordInstallEvent \}/);
    expect(src).toMatch(/eventType: "install"/);
  });

  it("afterAuth records INSTALLS, not every token exchange", () => {
    // afterAuth fires on re-auth too. Unfiltered, install counts would be
    // meaningless — but a reinstall of a soft-deleted row IS a real install and
    // must still land.
    const src = read("app", "shopify.server.ts");
    expect(src).toMatch(/if \(!priorRow \|\| priorRow\.uninstalled_at !== null\)/);
    // The state read must precede the upsert, which clears uninstalled_at.
    expect(src.indexOf("uninstalled_at, tier")).toBeLessThan(
      src.indexOf('from("merchants").upsert('),
    );
  });

  it("the uninstall handler records an uninstall WITH the tier", () => {
    const src = read("app", "routes", "webhooks.app.uninstalled.tsx");
    expect(src).toMatch(/eventType: "uninstall"/);
    // Free churn and paid churn are different events; without the tier the
    // ledger cannot separate them, which is half its purpose.
    const idx = src.indexOf('eventType: "uninstall"');
    expect(src.slice(idx, idx + 120)).toMatch(/tier: churnTier/);
  });

  it("the uninstall ledger write precedes the soft-delete", () => {
    // The tier lookup happens against a row this handler is about to mutate;
    // ordering keeps the recorded tier the pre-uninstall one.
    const src = read("app", "routes", "webhooks.app.uninstalled.tsx");
    expect(src.indexOf("recordInstallEvent")).toBeLessThan(src.indexOf("uninstalled_at:"));
  });

  it("shop/redact records BEFORE the hard delete", () => {
    // The load-bearing assertion for this block. After `.delete()` the merchant
    // row is gone and the tier is permanently unknowable.
    const src = read("app", "routes", "webhooks.shop.redact.tsx");
    const ledgerIdx = src.indexOf("recordInstallEvent({");
    const deleteIdx = src.indexOf('.from("merchants")\n      .delete()');
    expect(ledgerIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(ledgerIdx).toBeLessThan(deleteIdx);
  });

  it("shop/redact's ledger write cannot block the GDPR delete", () => {
    // Shopify does not retry shop/redact on non-2xx, so a throw here would be a
    // permanent silent compliance gap. The write sits in its own try/catch,
    // outside the delete's.
    const src = read("app", "routes", "webhooks.shop.redact.tsx");
    const ledgerIdx = src.indexOf("recordInstallEvent({");
    const between = src.slice(ledgerIdx, src.indexOf('.from("merchants")\n      .delete()'));
    expect(between).toMatch(/\}\s*catch\s*\{/);
  });

  it("shop/redact still ACKs 200 on every path", () => {
    const src = read("app", "routes", "webhooks.shop.redact.tsx");
    expect(src).toMatch(/return new Response\(null, \{ status: 200 \}\)/);
  });
});
