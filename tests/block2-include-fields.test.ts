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

  it("does NOT claim the delivery-count saving in a comment", () => {
    // The debounce behaviour is undocumented; the payload-size saving is not.
    // Keep the distinction explicit so nobody later reads it as established.
    expect(src).toMatch(/UNVERIFIED/);
    expect(src).toMatch(/CERTAIN/);
  });

  it("records the debounce hypothesis as RETIRED UNTESTED, not pending", () => {
    // The planned 48h delivery-count test measured products/update redelivery
    // volume, and products/update was unsubscribed 2026-07-29. Deliveries fall to
    // ~0 because the topic is gone, so the number can attribute nothing. Leaving
    // it recorded as "pending" would invite someone to run a comparison that
    // cannot answer the question.
    expect(src).toMatch(/RETIRED UNTESTED/);
    expect(src).toMatch(/48h test is void/);
    // ...and the change must be justified on the DOCUMENTED reason alone.
    expect(src).toMatch(/kept on reason 1\s*\n?\s*\*?\s*alone, which is documented/);
  });
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
