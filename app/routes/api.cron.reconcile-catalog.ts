/**
 * app/routes/api.cron.reconcile-catalog.ts
 *
 * BLOCK 4 — catalog reconcile, running IN PARALLEL with products/create +
 * products/update before either is switched off.
 *
 * Default mode is `observe`: it walks each paid merchant's catalog 250 products
 * at a time, decides enrichment need from the paged data alone (no per-product
 * round trip), and **writes nothing anywhere**. It then diffs its conclusions
 * against what the webhook path actually did over the same window, reading
 * `enrichment_webhook_log`. That diff is the gate artefact.
 *
 * The parity question this answers is narrow and deliberate. Both paths call the
 * SAME decision function (app/lib/enrichment/enrichment-decision.server.ts), so
 * the decisions cannot differ by construction — what is being tested is
 * DISCOVERY: does paging find the products the webhooks would have found? That
 * is the actual risk in dropping products/update, because a missed edit to an
 * existing product silently stops enrichment for the merchant paying for it.
 *
 * Two structural differences are expected and are NOT failures:
 *
 *   reconcile-only  Products needing enrichment that nobody edited in the
 *                   window. The webhook path is blind to these — it only ever
 *                   sees edits — which is the main reason to switch.
 *   webhook-only    Products edited in the window that need no write. The
 *                   webhook enqueues them anyway and the drainer discovers, one
 *                   Admin API round trip later, that there is nothing to do.
 *                   Every one of these is reported with the reconcile's reason
 *                   so it can be checked rather than assumed.
 *
 * The one genuine regression risk, stated plainly: webhook discovery is
 * event-latency, reconcile discovery is cycle-latency. A merchant who changes a
 * barcode is picked up within seconds today, and within one reconcile cycle
 * afterwards. At the 6h GitHub Actions cadence that is a worst case of ~6h of
 * staleness on a metafield nobody reads in real time. Any cadence claim must
 * come from the cron schedule, not from this comment.
 *
 * Query params (all optional):
 *   mode=observe|enqueue   default observe
 *   shop=<domain>          restrict to one shop
 *   window_hours=<n>       parity window, default 24
 *   after=<cursor>         resume a truncated walk (single-shop only)
 *   max_pages=<n>          bound the walk
 *   enqueue_cap=<n>        cap rows inserted in enqueue mode, default 500
 *
 * Auth: bearer CRON_SECRET, checked inside run() — never the HTTP verb. Vercel
 * Cron invokes with GET, GitHub Actions with POST; both delegate here. Do not
 * "restore" a method guard (see the 2026-07-28 dead-cron fix).
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { supabase } from "../supabase.server";
import { PAID_TIERS } from "../lib/billing/plans";
import { reconcileCatalog, type ReconciledProduct } from "../lib/enrichment/catalog-reconcile.server";
import { sentry } from "../lib/sentry.server";

/** Outcomes that mean the webhook path SAW this product in the window. */
const WEBHOOK_SAW_OUTCOMES = ["enqueued", "skip_dedup", "skip_already_queued"];

const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_ENQUEUE_CAP = 500;

function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  return run(request);
}

export async function action({ request }: ActionFunctionArgs) {
  return run(request);
}

interface ParityReport {
  window_hours: number;
  webhook_saw: number;
  reconcile_needs_work: number;
  /** Products both paths agree need work. */
  agreed: number;
  /** Edited in the window, reconcile says no work — with the reason for each. */
  webhook_only: number;
  webhook_only_by_reason: Record<string, number>;
  webhook_only_unexplained: string[];
  /** Needs work but nobody edited it — the coverage the webhooks never had. */
  reconcile_only: number;
}

async function run(request: Request) {
  const startedAt = Date.now();

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[cron/reconcile-catalog] CRON_SECRET env var is not set");
    return json({ error: "server_config_error" }, 500);
  }
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (token !== cronSecret) {
    return json({ error: "unauthorized" }, 401);
  }

  const url = new URL(request.url);
  const mode = url.searchParams.get("mode") === "enqueue" ? "enqueue" : "observe";
  const onlyShop = url.searchParams.get("shop");
  const windowHours = Number(url.searchParams.get("window_hours")) || DEFAULT_WINDOW_HOURS;
  const after = url.searchParams.get("after");
  const maxPages = Number(url.searchParams.get("max_pages")) || undefined;
  const enqueueCap = Number(url.searchParams.get("enqueue_cap")) || DEFAULT_ENQUEUE_CAP;

  // Paid, still-installed merchants only — same gate as the webhook tier check
  // and the drainer's merchants!inner join.
  let query = supabase
    .from("merchants")
    .select("id, shopify_domain, tier")
    .is("uninstalled_at", null)
    .in("tier", PAID_TIERS as readonly string[]);
  if (onlyShop) query = query.eq("shopify_domain", onlyShop);

  const { data: merchants, error: merchantErr } = await query;
  if (merchantErr) {
    return json({ error: "database_error", message: merchantErr.message }, 500);
  }
  if (!merchants || merchants.length === 0) {
    return json({ mode, merchants: 0, results: [] });
  }

  // write_products is what makes enrichment possible at all; without it the
  // drainer's metafieldsSet would fail, so enqueuing would be pure waste.
  const scopeOk = (process.env.SCOPES ?? "").includes("write_products");

  const results: Array<Record<string, unknown>> = [];

  for (const m of merchants) {
    try {
      const rec = await reconcileCatalog({
        shopDomain: m.shopify_domain,
        merchantId: m.id,
        mode: scopeOk ? mode : "observe",
        after: onlyShop ? after : null,
        enqueueCap,
        maxPages,
      });

      const parity = await buildParityReport({
        merchantId: m.id,
        windowHours,
        needsWork: rec.needsWork,
        noWork: rec.noWork,
      });

      results.push({
        shop: m.shopify_domain,
        tier: m.tier,
        mode: rec.mode,
        pages_walked: rec.pagesWalked,
        products_seen: rec.productsSeen,
        needs_work: rec.needsWork.length,
        no_work: rec.noWork.length,
        skipped_dedup_fresh: rec.skippedDedupFresh,
        enqueued: rec.enqueued,
        truncated: rec.truncated,
        next_cursor: rec.nextCursor,
        elapsed_ms: rec.elapsedMs,
        total_actual_query_cost: rec.totalActualQueryCost,
        errors: rec.errors,
        parity,
      });
    } catch (err) {
      sentry.captureException(err, {
        tags: { area: "cron.reconcile-catalog" },
        extra: { shop: m.shopify_domain },
      });
      results.push({
        shop: m.shopify_domain,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return json({
    mode,
    scope_ok: scopeOk,
    merchants: merchants.length,
    elapsed_ms: Date.now() - startedAt,
    results,
  });
}

/**
 * Diff the reconcile's conclusions against what the webhook path saw over the
 * same window. `webhook_only_unexplained` is the number that matters: a product
 * the webhooks enqueued that the reconcile neither flagged nor can account for
 * is a genuine discovery gap and must block the switch.
 */
async function buildParityReport(opts: {
  merchantId: string;
  windowHours: number;
  needsWork: ReconciledProduct[];
  noWork: ReconciledProduct[];
}): Promise<ParityReport> {
  const cutoff = new Date(Date.now() - opts.windowHours * 3600_000).toISOString();

  const webhookSaw = new Set<string>();
  const { data, error } = await supabase
    .from("enrichment_webhook_log")
    .select("product_id")
    .eq("merchant_id", opts.merchantId)
    .in("outcome", WEBHOOK_SAW_OUTCOMES)
    .gte("created_at", cutoff)
    .not("product_id", "is", null);
  if (!error) {
    for (const row of data ?? []) if (row.product_id) webhookSaw.add(String(row.product_id));
  }

  const needs = new Set(opts.needsWork.map((p) => p.numericProductId));
  const reasonById = new Map<string, string>();
  for (const p of opts.noWork) reasonById.set(p.numericProductId, p.reason);

  let agreed = 0;
  const byReason: Record<string, number> = {};
  const unexplained: string[] = [];
  for (const pid of webhookSaw) {
    if (needs.has(pid)) {
      agreed += 1;
      continue;
    }
    const reason = reasonById.get(pid);
    if (reason) {
      byReason[reason] = (byReason[reason] ?? 0) + 1;
    } else {
      // Not in the walked catalog at all. Either the product was deleted after
      // the webhook fired (benign, and the drainer would 'product_not_found'
      // too) or the walk was truncated before reaching it. The caller's
      // `truncated` flag disambiguates — never read this as benign on its own.
      byReason["not_in_walked_catalog"] = (byReason["not_in_walked_catalog"] ?? 0) + 1;
      if (unexplained.length < 25) unexplained.push(pid);
    }
  }

  return {
    window_hours: opts.windowHours,
    webhook_saw: webhookSaw.size,
    reconcile_needs_work: needs.size,
    agreed,
    webhook_only: webhookSaw.size - agreed,
    webhook_only_by_reason: byReason,
    webhook_only_unexplained: unexplained,
    reconcile_only: needs.size - agreed,
  };
}
