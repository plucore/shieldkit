/**
 * app/routes/api.cron.process-scan-triggers.ts
 *
 * Drains pending_scan_triggers in a small bounded batch per invocation. The
 * Vercel Hobby tier function ceiling is 60s; BATCH_SIZE=10 enrichments (~2s
 * each) keep us comfortably under it.
 *
 * Queue-head safety (2026-06-26): the drain SELECT joins merchants with an
 * INNER join and filters to PAID, still-installed merchants. A free-tier or
 * demoted merchant's rows are therefore NEVER selected, so they can never
 * reach — and wedge — the head of the queue. This is the durable fix for the
 * May-2026 poison pill (~860 demoted-merchant rows that stalled the drainer
 * under the old single-row, unscoped SELECT). Pre-existing free-tier rows are
 * removed out-of-band by scripts/purge-free-scan-triggers.ts.
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
 * 6 hours; Vercel Cron daily 12:00 UTC is the safety net.
 *
 * Auth: bearer CRON_SECRET.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { supabase } from "../supabase.server";
import { createAdminClient } from "../lib/shopify-api.server";
import { enrichProductMetafields } from "../lib/enrichment/gtin-enrichment.server";
import { hasPaidAccess, PAID_TIERS } from "../lib/billing/plans";
import { sentry } from "../lib/sentry.server";

// A bounded batch per invocation. Each enrichment touches one product gid and
// Shopify metafieldsSet usually returns in <2s, so 10 enrichments stay well
// under Vercel Hobby's 60s ceiling. Bumped 1→10 (2026-06-26): the legit paid
// backlog is tiny now, so a batch of 10 clears it in a single pass AND means a
// single slow/failed row no longer dominates an entire invocation.
const BATCH_SIZE = 10;

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
  // Embedded via the merchants!inner join in the drain SELECT. The join
  // restricts the queue head to PAID, still-installed merchants, so a free /
  // demoted merchant's rows can never reach (and wedge) the drainer.
  merchants: {
    shopify_domain: string;
    tier: string;
    uninstalled_at: string | null;
  };
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

  // Scope the queue head to PAID, still-installed merchants. merchants!inner
  // drops any row whose merchant fails the tier/uninstall filter, so a
  // free-tier or demoted merchant's rows are NEVER selected — the poison pill
  // that froze the queue at the May-2026 backlog cannot recur. Free-tier rows
  // still sitting in the table are removed out-of-band by
  // scripts/purge-free-scan-triggers.ts.
  const { data: rows, error: fetchErr } = await supabase
    .from("pending_scan_triggers")
    .select(
      "id, merchant_id, trigger_type, trigger_at, payload, merchants!inner(shopify_domain, tier, uninstalled_at)",
    )
    .is("processed_at", null)
    .is("merchants.uninstalled_at", null)
    .in("merchants.tier", PAID_TIERS as readonly string[])
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

  const triggerRows = (rows ?? []) as unknown as TriggerRow[];

  // Split paid-scoped rows into enrichment work vs legacy holdovers. Both are
  // already guaranteed to belong to a paid, installed merchant by the SELECT.
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

  // ── Enrichment triggers ─────────────────────────────────────────────────
  // The merchants!inner join already guarantees each row belongs to a paid,
  // installed merchant; the per-row guard below is defensive belt-and-braces
  // (e.g. a malformed payload with no product gid) that ALSO advances the row
  // so it can never wedge the head.
  for (const row of enrichmentRows) {
    const merchant = row.merchants;
    const productGid = row.payload?.product_gid;
    const numericId = row.payload?.numeric_product_id ?? null;

    if (
      !merchant ||
      merchant.uninstalled_at ||
      !productGid ||
      !hasPaidAccess(merchant.tier)
    ) {
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
      sentry.captureException(err, {
        tags: { area: "process-scan-triggers", branch: "enrich" },
        extra: { shop: merchant.shopify_domain, product_gid: productGid },
      });
      console.error(
        `[cron/process-scan-triggers] enrichment failed for ${merchant.shopify_domain} product ${productGid}:`,
        err instanceof Error ? err.message : err,
      );
    }

    // Forward-progress guarantee: advance the row regardless of the enrichment
    // outcome (success, skip, or thrown error) so one bad product can never
    // block the queue head.
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
 * Mark-processed. Returns true on success, false on failure. Supabase resolves
 * with an `error` object rather than throwing, so we check it explicitly: a
 * silently-swallowed write failure here is exactly what lets a row get
 * re-selected forever (the old BATCH_SIZE=1 poison pill), so on failure we
 * report to Sentry instead of returning a quiet false.
 */
async function markProcessed(ids: number[]): Promise<boolean> {
  try {
    const { error } = await supabase
      .from("pending_scan_triggers")
      .update({ processed_at: new Date().toISOString() })
      .in("id", ids);
    if (error) throw new Error(error.message);
    return true;
  } catch (err) {
    sentry.captureException(err, {
      tags: { area: "process-scan-triggers", branch: "mark_processed" },
      extra: { ids },
    });
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
