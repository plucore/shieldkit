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

// Upper bound on rows SELECTed per invocation. The real limiter is
// TIME_BUDGET_MS below — BATCH_SIZE only caps the query so a huge backlog
// doesn't pull an enormous result set into memory.
//
// History: 1 → 10 (2026-06-26) → 100 (2026-07-28). The 10 was sized for "the
// legit paid backlog is tiny now", which stopped being true when a paying
// merchant with a large catalog upgraded on 2026-07-12. At 10/invocation ×
// 4 GitHub Actions runs/day = 40 rows/day against a ~600/day inbound rate, the
// queue accumulated a 3,358-row backlog reaching back to 2026-07-13 — i.e. the
// paying customer's enrichment was ~14 days stale and falling further behind
// daily.
const BATCH_SIZE = 100;

// Wall-clock guard. Vercel Hobby hard-kills a function at 60s; a kill mid-batch
// loses the unmarked rows' work (they stay unprocessed, so it is safe, just
// wasteful). Stop admitting new products at 45s, leaving ~15s of headroom for
// the in-flight product to finish, the final markProcessed, and the response.
const TIME_BUDGET_MS = 45_000;

// Products processed concurrently. Raising BATCH_SIZE alone is inert: each
// enrichment is a ~2s Shopify round-trip, so a serial loop only ever completes
// ~20 products inside the time budget no matter how many rows were selected.
// A small pool is what actually converts the budget into throughput (~5x).
// Kept deliberately low: Shopify's Admin GraphQL cost limit is per-shop, and in
// practice a backlog belongs to one merchant, so all concurrency lands on a
// single shop's bucket. 5 is comfortably inside the standard leaky-bucket
// refill rate for calls this cheap.
const ENRICH_CONCURRENCY = 5;

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

// Vercel Cron invokes a scheduled path with **GET**, which React Router routes
// to the loader. This route used to 405 every GET, so the declared Vercel cron
// (vercel.json) never did any work — the queue was drained solely by the
// GitHub Actions workflow, which passes `--request POST`. Both verbs now run
// the same handler; the bearer CRON_SECRET check inside `run()` is the only
// authorisation gate, so widening the verb does not widen access. Vercel
// automatically sends `Authorization: Bearer $CRON_SECRET` when that env var is
// set. Fixed 2026-07-28.
export async function loader({ request }: LoaderFunctionArgs) {
  return run(request);
}

export async function action({ request }: ActionFunctionArgs) {
  return run(request);
}

async function run(request: Request) {
  // Stamped before any work so TIME_BUDGET_MS covers the auth + SELECT too,
  // not just the enrichment loop.
  const startedAt = Date.now();

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
  // Worker-pool drain. `cursor` is the shared index into enrichmentRows;
  // because JS is single-threaded, `cursor++` is atomic with respect to the
  // other workers, so each row is claimed exactly once. Every worker re-checks
  // the wall clock before claiming, so the pool winds down cleanly at the
  // budget instead of being killed mid-flight at 60s.
  let cursor = 0;
  let timedOut = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        timedOut = true;
        return;
      }
      const index = cursor++;
      if (index >= enrichmentRows.length) return;
      await processEnrichmentRow(enrichmentRows[index]);
    }
  };

  const processEnrichmentRow = async (row: TriggerRow): Promise<void> => {
    const merchant = row.merchants;
    const productGid = row.payload?.product_gid;
    const numericId = row.payload?.numeric_product_id ?? null;

    if (
      !merchant ||
      merchant.uninstalled_at ||
      !productGid ||
      !hasPaidAccess(merchant.tier)
    ) {
      if (await markProcessed([row.id])) triggersProcessed += 1;
      return;
    }

    try {
      const admin = await createAdminClient(merchant.shopify_domain);
      const adminLike = makeAdminLike(admin);
      const result = await enrichProductMetafields(adminLike, productGid);

      // Write the dedup anchor whenever the product was successfully EXAMINED,
      // not only when fields were actually written.
      //
      // Was: `result.ok && result.written.length > 0 && numericId`. A product
      // that already had all three metafields returns ok with written=[], so no
      // schema_enrichments row was created — and that table is exactly what the
      // webhook's 24h dedup reads (webhooks.products.update.tsx:107-115, which
      // checks only `enriched_at`, never the field list). With no anchor, the
      // next products/update for that product re-enqueued, the drainer wrote
      // nothing again, and the cycle repeated forever. The deep backlog has
      // been masking this: repeat deliveries hit `skip_already_queued` instead.
      // Clearing the backlog without this fix would have turned that latent
      // loop live. An empty `enriched_fields` array is the correct record of
      // "examined, nothing to do" (the column is nullable; [] is valid).
      if (result.ok && numericId) {
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
  };

  await Promise.all(
    Array.from({ length: Math.min(ENRICH_CONCURRENCY, enrichmentRows.length) }, worker),
  );

  return json({
    // `timed_out` + `unclaimed` make backlog burn-down observable from the
    // cron response alone: a run that keeps reporting timed_out=true with a
    // non-zero unclaimed count means the queue is still growing faster than
    // this cadence drains it.
    timed_out: timedOut,
    unclaimed: Math.max(0, enrichmentRows.length - cursor),
    elapsed_ms: Date.now() - startedAt,
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
