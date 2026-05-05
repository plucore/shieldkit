/**
 * app/routes/webhooks.products.update.tsx
 *
 * Phase 7.1 — Continuous GTIN/MPN/brand enrichment.
 * Phase 7.3 — Doubles as a "scan trigger" for storefront monitoring.
 *
 * Subscribes to: products/create + products/update.
 *
 * Behavior:
 *   1. authenticate.webhook(request) — HMAC verified by Shopify SDK.
 *   2. Look up merchant by shop domain. Bail (200 OK) on no match.
 *   3. Insert pending_scan_triggers row (Phase 7.3) — gated by tier
 *      IN ('shield','pro') with a 24h dedup window.
 *   4. Tier gate: tier='pro' (Shield Max) for the GTIN enrichment.
 *   5. Scope gate: SCOPES env must include write_products.
 *   6. Dedup: skip if schema_enrichments has a row for this product
 *      within the last 24h.
 *   7. Run enrichProductMetafields with a 3s safety budget.
 *   8. ALWAYS ack 200 — never let webhook errors bubble.
 */

import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";
import { enrichProductMetafields, gidToNumericId } from "../lib/enrichment/gtin-enrichment.server";

const SAFETY_BUDGET_MS = 3000;
const ENRICHMENT_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

function ack(): Response {
  return new Response();
}

async function logOutcome(opts: {
  merchantId: string | null;
  productId: string | null;
  topic: string;
  outcome: string;
  written?: string[];
  errorMessage?: string;
}): Promise<void> {
  try {
    await supabase.from("enrichment_webhook_log").insert({
      merchant_id: opts.merchantId,
      product_id: opts.productId,
      topic: opts.topic,
      outcome: opts.outcome,
      written_keys: opts.written ?? null,
      error_message: opts.errorMessage ?? null,
    });
  } catch {
    // Never let logging failures escape.
  }
}

async function maybeRecordScanTrigger(opts: {
  merchantId: string;
  tier: string;
}): Promise<void> {
  // Phase 7.3 — only paid tiers get continuous monitoring.
  if (opts.tier !== "shield" && opts.tier !== "pro") return;

  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: existing } = await supabase
      .from("pending_scan_triggers")
      .select("id")
      .eq("merchant_id", opts.merchantId)
      .is("processed_at", null)
      .gte("trigger_at", cutoff)
      .limit(1);

    if (existing && existing.length > 0) {
      // 24h dedup — already queued.
      return;
    }

    await supabase.from("pending_scan_triggers").insert({
      merchant_id: opts.merchantId,
      trigger_type: "product_update",
    });
  } catch (err) {
    console.warn(
      "[webhooks.products.update] scan-trigger insert failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  // 1. HMAC verification — throws 401 Response on failure.
  const { shop, payload, topic, admin } = await authenticate.webhook(request);

  // 2. Look up merchant.
  const { data: merchant } = await supabase
    .from("merchants")
    .select("id, tier")
    .eq("shopify_domain", shop)
    .maybeSingle();

  if (!merchant) {
    await logOutcome({
      merchantId: null,
      productId: null,
      topic,
      outcome: "skip_no_merchant",
    });
    return ack();
  }

  // Resolve product id (payload.id is numeric, e.g. 7890123456789).
  const numericId =
    payload && typeof (payload as { id?: number }).id === "number"
      ? String((payload as { id: number }).id)
      : null;
  const productGid = numericId ? `gid://shopify/Product/${numericId}` : null;

  // Phase 7.3 — record scan trigger (independent of GTIN enrichment).
  await maybeRecordScanTrigger({ merchantId: merchant.id, tier: merchant.tier });

  // 3. Tier gate — Shield Max only for GTIN enrichment.
  if (merchant.tier !== "pro") {
    await logOutcome({
      merchantId: merchant.id,
      productId: numericId,
      topic,
      outcome: "skip_tier",
    });
    return ack();
  }

  // 4. Scope gate.
  if (!(process.env.SCOPES ?? "").includes("write_products")) {
    await logOutcome({
      merchantId: merchant.id,
      productId: numericId,
      topic,
      outcome: "skip_scope",
    });
    return ack();
  }

  if (!productGid || !numericId) {
    await logOutcome({
      merchantId: merchant.id,
      productId: null,
      topic,
      outcome: "skip_no_product_id",
    });
    return ack();
  }

  // 5. Dedup — skip if we enriched this product in the last 24h.
  try {
    const cutoff = new Date(Date.now() - ENRICHMENT_DEDUP_WINDOW_MS).toISOString();
    const { data: existing } = await supabase
      .from("schema_enrichments")
      .select("enriched_at")
      .eq("merchant_id", merchant.id)
      .eq("product_id", numericId)
      .order("enriched_at", { ascending: false })
      .limit(1);
    if (existing && existing[0] && existing[0].enriched_at >= cutoff) {
      await logOutcome({
        merchantId: merchant.id,
        productId: numericId,
        topic,
        outcome: "skip_dedup",
      });
      return ack();
    }
  } catch (err) {
    // Dedup failure is non-fatal — better to risk a duplicate write than
    // silently drop on a transient DB hiccup.
    console.warn(
      "[webhooks.products.update] dedup check failed, proceeding:",
      err instanceof Error ? err.message : err,
    );
  }

  if (!admin) {
    // No session means we can't talk to the Admin API. Still ack so Shopify
    // doesn't retry indefinitely.
    await logOutcome({
      merchantId: merchant.id,
      productId: numericId,
      topic,
      outcome: "skip_no_admin",
    });
    return ack();
  }

  // 6. Run with a safety budget.
  const enrichmentPromise = enrichProductMetafields(admin, productGid);
  const timeoutPromise = new Promise<{ ok: false; written: never[]; skipped: never[]; error: string }>(
    (resolve) =>
      setTimeout(
        () => resolve({ ok: false, written: [], skipped: [], error: "timeout_3s" }),
        SAFETY_BUDGET_MS,
      ),
  );

  try {
    const result = await Promise.race([enrichmentPromise, timeoutPromise]);

    if (result.ok && result.written.length > 0) {
      try {
        await supabase
          .from("schema_enrichments")
          .upsert(
            {
              merchant_id: merchant.id,
              product_id: numericId,
              enriched_fields: result.written,
              metafield_values: {},
              enriched_at: new Date().toISOString(),
            },
            { onConflict: "merchant_id,product_id" },
          );
      } catch (err) {
        console.warn(
          "[webhooks.products.update] schema_enrichments upsert failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    await logOutcome({
      merchantId: merchant.id,
      productId: numericId,
      topic,
      outcome: result.ok
        ? result.written.length > 0
          ? "enriched"
          : "noop"
        : "error",
      written: result.written,
      errorMessage: result.ok ? undefined : result.error,
    });
  } catch (err) {
    await logOutcome({
      merchantId: merchant.id,
      productId: numericId,
      topic,
      outcome: "error",
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }

  // Suppress unused-warning when caller doesn't read the gid helper.
  void gidToNumericId;

  return ack();
};
