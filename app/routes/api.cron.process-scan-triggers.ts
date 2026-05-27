/**
 * app/routes/api.cron.process-scan-triggers.ts
 *
 * Drains pending_scan_triggers one merchant per invocation. A scan runs
 * ~10–15s; the Vercel Hobby tier function ceiling is 60s, so we cap each
 * invocation at a single merchant to stay safely under the limit.
 *
 * Trigger-type vocabulary:
 *   - weekly_scan / theme_update / theme_publish / product_update
 *       → run runComplianceScan for the merchant. Multiple of these for the
 *         same merchant in one tick are coalesced into a single scan.
 *   - enrichment   (Fix 9 — 2026-05-27)
 *       → run enrichProductMetafields against the product gid carried in
 *         the trigger row's payload column. Processed individually because
 *         each enrichment is per-product, not per-merchant.
 *
 * Invocation cadence: a GitHub Actions workflow
 * (.github/workflows/process-scan-triggers.yml) curls this endpoint every
 * 30 minutes. Auth: bearer CRON_SECRET, mirrors api.cron.weekly-scan.ts.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { supabase } from "../supabase.server";
import { runComplianceScan } from "../lib/compliance-scanner.server";
import { createAdminClient } from "../lib/shopify-api.server";
import { enrichProductMetafields } from "../lib/enrichment/gtin-enrichment.server";

// One merchant per invocation. With a ~12s scan, this stays well under the
// 60s Vercel Hobby ceiling and leaves room for transient slow GraphQL calls.
const BATCH_SIZE = 1;

function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface TriggerRow {
  id: number;
  merchant_id: string;
  trigger_type: string;
  trigger_at: string;
  payload: { product_gid?: string; numeric_product_id?: string } | null;
}

export async function loader(_args: LoaderFunctionArgs) {
  return json(
    { error: "method_not_allowed", message: "Use POST /api/cron/process-scan-triggers." },
    405,
  );
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed", message: "Use POST." }, 405);
  }

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[cron/process-scan-triggers] CRON_SECRET env var is not set");
    return json({ error: "server_config_error" }, 500);
  }
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (token !== cronSecret) {
    return json({ error: "unauthorized" }, 401);
  }

  const { data: rows, error: fetchErr } = await supabase
    .from("pending_scan_triggers")
    .select("id, merchant_id, trigger_type, trigger_at, payload")
    .is("processed_at", null)
    .order("trigger_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (fetchErr) {
    console.error(
      "[cron/process-scan-triggers] failed to fetch triggers:",
      fetchErr.message,
    );
    return json({ error: "database_error", message: fetchErr.message }, 500);
  }

  if (!rows || rows.length === 0) {
    return json({ merchants_scanned: 0, enrichments_processed: 0, triggers_processed: 0 });
  }

  const triggerRows = rows as TriggerRow[];

  // Look up shopify_domain + status for all merchants referenced.
  const merchantIds = Array.from(new Set(triggerRows.map((r) => r.merchant_id)));
  const { data: merchantRows } = await supabase
    .from("merchants")
    .select("id, shopify_domain, tier, uninstalled_at")
    .in("id", merchantIds);

  const merchantsById = new Map<
    string,
    { shopify_domain: string; tier: string; uninstalled_at: string | null }
  >();
  for (const m of (merchantRows ?? []) as Array<{
    id: string;
    shopify_domain: string;
    tier: string;
    uninstalled_at: string | null;
  }>) {
    merchantsById.set(m.id, {
      shopify_domain: m.shopify_domain,
      tier: m.tier,
      uninstalled_at: m.uninstalled_at,
    });
  }

  let merchantsScanned = 0;
  let enrichmentsProcessed = 0;
  let errors = 0;
  let triggersProcessed = 0;

  // Split scan-class vs enrichment triggers. Scan-class get coalesced per
  // merchant (one scan covers all change events). Enrichments are per-product.
  const scanRowsByMerchant = new Map<string, TriggerRow[]>();
  const enrichmentRows: TriggerRow[] = [];

  for (const row of triggerRows) {
    if (row.trigger_type === "enrichment") {
      enrichmentRows.push(row);
    } else {
      const list = scanRowsByMerchant.get(row.merchant_id) ?? [];
      list.push(row);
      scanRowsByMerchant.set(row.merchant_id, list);
    }
  }

  // ── Scan-class triggers ────────────────────────────────────────────────────
  for (const [merchantId, mRows] of scanRowsByMerchant) {
    const ids = mRows.map((r) => r.id);
    const merchant = merchantsById.get(merchantId);

    if (!merchant || merchant.uninstalled_at) {
      // Defensive: still mark processed so triggers don't accumulate.
      await markProcessed(ids);
      triggersProcessed += ids.length;
      continue;
    }

    try {
      await runComplianceScan(merchantId, merchant.shopify_domain, "automated");
      merchantsScanned++;
    } catch (err) {
      errors++;
      console.error(
        `[cron/process-scan-triggers] scan failed for ${merchant.shopify_domain}:`,
        err instanceof Error ? err.message : err,
      );
    }

    if (await markProcessed(ids)) triggersProcessed += ids.length;
  }

  // ── Enrichment triggers (Fix 9) ───────────────────────────────────────────
  for (const row of enrichmentRows) {
    const merchant = merchantsById.get(row.merchant_id);
    const productGid = row.payload?.product_gid;
    const numericId = row.payload?.numeric_product_id ?? null;

    if (!merchant || merchant.uninstalled_at || !productGid) {
      await markProcessed([row.id]);
      triggersProcessed += 1;
      continue;
    }

    try {
      const admin = await createAdminClient(merchant.shopify_domain);
      const adminLike = makeAdminLike(admin);
      const result = await enrichProductMetafields(adminLike, productGid);

      if (result.ok && result.written.length > 0 && numericId) {
        try {
          await supabase
            .from("schema_enrichments")
            .upsert(
              {
                merchant_id: row.merchant_id,
                product_id: numericId,
                enriched_fields: result.written,
                metafield_values: {},
                enriched_at: new Date().toISOString(),
              },
              { onConflict: "merchant_id,product_id" },
            );
        } catch (err) {
          console.warn(
            "[cron/process-scan-triggers] schema_enrichments upsert failed:",
            err instanceof Error ? err.message : err,
          );
        }
      }

      enrichmentsProcessed++;
    } catch (err) {
      errors++;
      console.error(
        `[cron/process-scan-triggers] enrichment failed for ${merchant.shopify_domain} product ${productGid}:`,
        err instanceof Error ? err.message : err,
      );
    }

    if (await markProcessed([row.id])) triggersProcessed += 1;
  }

  return json({
    merchants_scanned: merchantsScanned,
    enrichments_processed: enrichmentsProcessed,
    triggers_processed: triggersProcessed,
    errors,
  });
}

/**
 * Best-effort mark-processed. Returns true on success, false on failure
 * (errors are logged but never thrown — we'd rather over-deliver than
 * lose track of a row).
 */
async function markProcessed(ids: number[]): Promise<boolean> {
  try {
    await supabase
      .from("pending_scan_triggers")
      .update({ processed_at: new Date().toISOString() })
      .in("id", ids);
    return true;
  } catch (err) {
    console.error(
      "[cron/process-scan-triggers] failed to mark processed:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * enrichProductMetafields expects a Shopify admin client shape that has
 * `admin.graphql(query, options?)` returning a Response-like object whose
 * `.json()` resolves to the GraphQL response. createAdminClient returns
 * the bare executor function — wrap it so the call signatures line up.
 */
type ShopifyAdminLike = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<{ json: () => Promise<unknown> }>;
};

function makeAdminLike(
  executor: (
    query: string,
    variables?: Record<string, unknown>,
  ) => Promise<unknown>,
): ShopifyAdminLike {
  return {
    graphql: async (query, options) => {
      const result = await executor(query, options?.variables);
      return { json: async () => result };
    },
  };
}
