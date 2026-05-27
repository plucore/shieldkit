/**
 * app/routes/webhooks.products.update.tsx
 *
 * Phase 7.1 — Continuous GTIN/MPN/brand enrichment.
 * Phase 7.3 — Doubles as a "scan trigger" for storefront monitoring.
 * Fix 9 (2026-05-27) — Enrichment moved off the webhook hot path. The
 *   webhook now enqueues a pending_scan_triggers row with
 *   trigger_type='enrichment'; the drainer
 *   (api.cron.process-scan-triggers.ts) runs the actual enrichment with
 *   the full 60s Vercel function ceiling.
 *
 * Subscribes to: products/create + products/update.
 *
 * Behaviour:
 *   1. authenticate.webhook(request) — HMAC verified by Shopify SDK.
 *   2. Look up merchant by shop domain. Bail (200 OK) on no match.
 *   3. Tier gate: hasMonitoringAccess.
 *   4. Insert pending_scan_triggers row for trigger_type='product_update'
 *      (24h-deduped — drives the storefront scan).
 *   5. Insert pending_scan_triggers row for trigger_type='enrichment' with
 *      the product gid as payload (24h-deduped against schema_enrichments).
 *   6. ALWAYS ack 200 — never let webhook errors bubble.
 */

import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";
import { hasMonitoringAccess } from "../lib/billing/plans";

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
  // v3 — only monitoring-access tiers get continuous scan triggers.
  if (!hasMonitoringAccess(opts.tier)) return;

  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: existing } = await supabase
      .from("pending_scan_triggers")
      .select("id")
      .eq("merchant_id", opts.merchantId)
      .eq("trigger_type", "product_update")
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

/**
 * Enqueue an enrichment job for the drainer. Same 24h dedup pattern as the
 * scan trigger but keyed against schema_enrichments so we don't re-enqueue
 * for a product we already enriched recently.
 */
async function maybeEnqueueEnrichment(opts: {
  merchantId: string;
  numericProductId: string;
  productGid: string;
  topic: string;
}): Promise<void> {
  // Dedup against the historical record so we don't enqueue a job for a
  // product we successfully enriched within the last 24h.
  try {
    const cutoff = new Date(Date.now() - ENRICHMENT_DEDUP_WINDOW_MS).toISOString();
    const { data: existing } = await supabase
      .from("schema_enrichments")
      .select("enriched_at")
      .eq("merchant_id", opts.merchantId)
      .eq("product_id", opts.numericProductId)
      .order("enriched_at", { ascending: false })
      .limit(1);
    if (existing && existing[0] && existing[0].enriched_at >= cutoff) {
      await logOutcome({
        merchantId: opts.merchantId,
        productId: opts.numericProductId,
        topic: opts.topic,
        outcome: "skip_dedup",
      });
      return;
    }
  } catch (err) {
    // Non-fatal: better a duplicate enrichment than a silent drop.
    console.warn(
      "[webhooks.products.update] enrichment dedup check failed, enqueuing anyway:",
      err instanceof Error ? err.message : err,
    );
  }

  // Also dedup against an already-queued unprocessed enrichment trigger
  // for the same product — a flurry of webhook deliveries shouldn't
  // generate dozens of identical queue rows.
  try {
    const { data: queued } = await supabase
      .from("pending_scan_triggers")
      .select("id")
      .eq("merchant_id", opts.merchantId)
      .eq("trigger_type", "enrichment")
      .is("processed_at", null)
      .contains("payload", { numeric_product_id: opts.numericProductId })
      .limit(1);
    if (queued && queued.length > 0) {
      await logOutcome({
        merchantId: opts.merchantId,
        productId: opts.numericProductId,
        topic: opts.topic,
        outcome: "skip_already_queued",
      });
      return;
    }
  } catch (err) {
    // Non-fatal — fall through to insert. Postgres @> on jsonb is cheap
    // but the dedup itself is best-effort, not load-bearing.
    console.warn(
      "[webhooks.products.update] enrichment queue dedup failed:",
      err instanceof Error ? err.message : err,
    );
  }

  const { error: insertErr } = await supabase
    .from("pending_scan_triggers")
    .insert({
      merchant_id: opts.merchantId,
      trigger_type: "enrichment",
      payload: {
        product_gid: opts.productGid,
        numeric_product_id: opts.numericProductId,
      },
    });

  if (insertErr) {
    await logOutcome({
      merchantId: opts.merchantId,
      productId: opts.numericProductId,
      topic: opts.topic,
      outcome: "error",
      errorMessage: `enqueue_failed: ${insertErr.message}`,
    });
    return;
  }

  await logOutcome({
    merchantId: opts.merchantId,
    productId: opts.numericProductId,
    topic: opts.topic,
    outcome: "enqueued",
  });
}

export const action = async ({ request }: ActionFunctionArgs) => {
  // 1. HMAC verification — throws 401 Response on failure.
  const { shop, payload, topic } = await authenticate.webhook(request);

  // 2. Look up merchant.
  const { data: merchant } = await supabase
    .from("merchants")
    .select("id, tier, uninstalled_at")
    .eq("shopify_domain", shop)
    .maybeSingle();

  if (!merchant) {
    // skip_no_merchant — race between OAuth and first webhook delivery, or
    // stale subscription on an uninstalled shop. Logging removed 2026-05-20.
    return ack();
  }

  // Uninstalled merchants must not trigger any future write. (skip_uninstalled)
  // Guarded before maybeRecordScanTrigger and the tier/scope gates.
  if (merchant.uninstalled_at) {
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

  // 3. Tier gate (skip_tier) — ongoing GTIN enrichment on newly-updated
  // products is a Monitoring-level feature. Bulk fill on the existing
  // catalog is gated separately in app.gtin-fill.tsx via hasRecoveryAccess.
  if (!hasMonitoringAccess(merchant.tier)) {
    return ack();
  }

  // 4. Scope gate (skip_scope).
  if (!(process.env.SCOPES ?? "").includes("write_products")) {
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

  // 5. Enqueue the enrichment job. Returns fast (<1s total webhook ACK).
  await maybeEnqueueEnrichment({
    merchantId: merchant.id,
    numericProductId: numericId,
    productGid,
    topic,
  });

  return ack();
};
