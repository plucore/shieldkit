/**
 * tests/block2-include-fields.test.ts
 *
 * The products/* subscriptions are narrowed to `includeFields: ["id"]` — the only
 * payload field webhooks.products.update.tsx actually reads.
 *
 * The trap this guards: `ensureProductWebhooks` short-circuits on
 * `alreadyTargeted`, so a change to the desired field list would apply ONLY to
 * future subscribers and never to the merchants who already have subscriptions —
 * i.e. the one paying merchant it is meant to help. Same class of mistake as
 * committing a toml change without deploying it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");

describe("products/* subscriptions request only the field the handler reads", () => {
  const src = read("app", "lib", "webhooks", "product-webhooks.server.ts");
  const handler = read("app", "routes", "webhooks.products.update.tsx");

  it("declares includeFields as exactly ['id']", () => {
    expect(src).toMatch(/DESIRED_INCLUDE_FIELDS\s*=\s*\["id"\]\s*as const/);
  });

  it("the handler genuinely reads no other payload field", () => {
    // If this ever fails, the narrowing is starving the handler — widen
    // DESIRED_INCLUDE_FIELDS in the same change.
    const payloadReads = [...handler.matchAll(/payload as \{\s*(\w+)\??:/g)].map((m) => m[1]);
    for (const field of payloadReads) {
      expect(["id"], `handler reads payload.${field}, not covered by includeFields`).toContain(
        field,
      );
    }
    expect(payloadReads.length).toBeGreaterThan(0); // the assertion must be live
  });

  it("CREATE passes includeFields", () => {
    const createIdx = src.indexOf("CREATE_MUTATION, {");
    expect(createIdx).toBeGreaterThan(-1);
    expect(src.slice(createIdx, createIdx + 260)).toMatch(
      /includeFields:\s*\[\.\.\.DESIRED_INCLUDE_FIELDS\]/,
    );
  });

  it("EXISTING subscriptions are updated in place, not skipped", () => {
    // The load-bearing assertion. Without this the change is invisible to every
    // merchant who already had a subscription.
    expect(src).toMatch(/UPDATE_MUTATION/);
    expect(src).toMatch(/webhookSubscriptionUpdate/);
    const loopIdx = src.indexOf("if (alreadyTargeted.has(topic))");
    expect(loopIdx).toBeGreaterThan(-1);
    const branch = src.slice(loopIdx, loopIdx + 2200);
    // It must consult the existing subscription's current includeFields...
    expect(branch).toMatch(/existingByTopic\.get\(topic\)/);
    // ...compare against the desired list...
    expect(branch).toMatch(/upToDate/);
    // ...and issue an update when they differ, BEFORE the `continue`.
    expect(branch.indexOf("UPDATE_MUTATION")).toBeLessThan(branch.indexOf("continue;"));
  });

  it("the LIST query returns includeFields so drift is detectable", () => {
    const listIdx = src.indexOf("const LIST_QUERY");
    expect(src.slice(listIdx, listIdx + 500)).toMatch(/includeFields/);
  });

  it("an already-narrowed subscription is NOT needlessly re-updated", () => {
    // upToDate must be computed and must gate the update, or every reconcile
    // pass would issue a redundant mutation for every paid merchant.
    expect(src).toMatch(/if \(existing && !upToDate\)/);
  });

  // DELETED 2026-07-29: two tests that asserted the ENGLISH PROSE of a code
  // comment — /UNVERIFIED/, /CERTAIN/, /RETIRED UNTESTED/, /48h test is void/,
  // and a regex for the exact wording of a sentence fragment.
  //
  // They protected no behaviour. Every one of them would still have passed with
  // `includeFields` removed from the CREATE mutation entirely, as long as the
  // comment survived — and they broke on any rewording, including a prettier
  // reflow (the third regex tried to tolerate that and only half succeeded).
  //
  // The distinction they were reaching for is real and worth keeping: the
  // payload-size saving is documented, the delivery-count debounce never was.
  // But that belongs in the comment itself, where it now lives, not in an
  // assertion that pins its phrasing. What actually needs protecting is the
  // BEHAVIOUR — that includeFields is declared, passed on create, and pushed to
  // existing subscriptions — and the tests above already do that.
});

describe("products/* remain per-shop, so `shopify app deploy` is NOT the mechanism", () => {
  it("shopify.app.toml still declares no products topic", () => {
    const toml = read("shopify.app.toml");
    expect(toml).not.toMatch(/topics\s*=\s*\[\s*"products\//);
    // The explanatory comment must survive — it is why this change reaches
    // production through a Vercel deploy plus ensureProductWebhooks, not
    // through `shopify app deploy`.
    expect(toml).toMatch(/intentionally NOT declared/);
  });

  it("ensureProductWebhooks is reachable from a scheduled job, not just auth", () => {
    // Existing merchants get the narrowing when reconcile-subscriptions next
    // runs; without that path the update would wait for a re-auth that may
    // never happen.
    const cron = read("app", "routes", "api.cron.reconcile-subscriptions.ts");
    expect(cron).toMatch(/ensureProductWebhooks/);
  });
});
