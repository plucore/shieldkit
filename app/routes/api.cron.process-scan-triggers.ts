/**
 * app/routes/api.cron.process-scan-triggers.ts
 *
 * Drains pending_scan_triggers, one merchant per invocation. The Vercel
 * Hobby tier function ceiling is 60s; a single-row batch keeps us safely
 * under it.
 *
 * Trigger-type vocabulary (v4 — 2026-05-28):
 *   - enrichment   → run enrichProductMetafields against the product gid
 *                    carried in the trigger row's payload column. This is
 *                    the only trigger type the drainer acts on after v4
 *                    dropped weekly auto-scans + theme/product scan triggers.
 *   - weekly_scan / theme_update / theme_publish / product_update
 *                  → legacy types. The webhooks/crons that enqueued these
 *                    were removed in v4 §3-§4; if any historical rows still
 *                    exist in the table the drainer marks them processed
 *                    without acting on them (no-op + advance).
 *
 * Invocation cadence: a GitHub Actions workflow
 * (.github/workflows/process-scan-triggers.yml) curls this endpoint every
 * 30 minutes; Vercel Cron daily 12:00 UTC is the safety net.
 *
 * Auth: bearer CRON_SECRET.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { supabase } from "../supabase.server";
import { createAdminClient } from "../lib/shopify-api.server";
import { enrichProductMetafields } from "../lib/enrichment/gtin-enrichment.server";

// One merchant per invocation. Each enrichment touches one product gid
// and Shopify metafieldsSet usually returns in <2s; the BATCH_SIZE=1 cap
// inherited from the v3 scan-drain pattern stays for safety.
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
    return json({ enrichments_processed: 0, legacy_skipped: 0, triggers_processed: 0 });
  }

  const triggerRows = rows as TriggerRow[];

  // Look up shopify_domain + uninstalled_at for merchants referenced by
  // active enrichment rows. Legacy-type rows don't need it (they're just
  // being advanced).
  const enrichmentRows = triggerRows.filter((r) => r.trigger_type === "enrichment");
  const legacyRows = triggerRows.filter((r) => r.trigger_type !== "enrichment");

  let enrichmentsProcessed = 0;
  let legacySkipped = 0;
  let errors = 0;
  let triggersProcessed = 0;

  // Advance legacy rows without doing any work — they're holdovers from
  // pre-v4 weekly_scan / theme / product_update enqueues.
  for (const row of legacyRows) {
    if (await markProcessed([row.id])) {
      triggersProcessed += 1;
      legacySkipped += 1;
    }
  }

  if (enrichmentRows.length === 0) {
    return json({
      enrichments_processed: 0,
      legacy_skipped: legacySkipped,
      triggers_processed: triggersProcessed,
      errors,
    });
  }

  const merchantIds = Array.from(new Set(enrichmentRows.map((r) => r.merchant_id)));
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

  // ── Enrichment triggers ─────────────────────────────────────────────────
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
    enrichments_processed: enrichmentsProcessed,
    legacy_skipped: legacySkipped,
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
