/**
 * app/routes/api.cron.reconcile-catalog.ts
 *
 * BLOCK 4 — catalog reconcile. **Since 2026-07-29 this is THE enrichment
 * discovery path**, not a parallel observer: products/update was unsubscribed on
 * that date, so nothing else finds a product that needs GTIN/MPN/brand work after
 * an edit. products/create is still subscribed, so brand-new products are still
 * picked up within seconds; everything else is picked up on this job's cadence.
 *
 * It walks each paid merchant's catalog 250 products at a time and decides
 * enrichment need from the paged data alone (no per-product round trip), then
 * enqueues `pending_scan_triggers` rows. `api.cron.process-scan-triggers` remains
 * the single writer.
 *
 * `mode` still defaults to `observe` at the ROUTE level — a bare unauthenticated-
 * shaped call can never write — and `.github/workflows/reconcile-catalog.yml`
 * passes `mode=enqueue` explicitly on its schedule. It also diffs its conclusions
 * against `enrichment_webhook_log` over a window; that diff was the gate artefact
 * and is now a regression check, though it decays in usefulness as the webhook log
 * ages out of the window.
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
 *   budget_ms=<n>          per-shop wall-clock budget, default 25s multi-shop
 *   reset_cursor=1         discard the saved cursor and restart the cycle
 *
 * CURSOR PERSISTENCE (catalog_reconcile_state, 2026-07-29). A large catalog does
 * not fit in one invocation, so the walk resumes where the last one stopped. This
 * is load-bearing, not an optimisation: on the scheduled multi-shop run each shop
 * gets ~22s while sex-eshop's 31 pages need ~45s, so without a saved cursor the
 * walk would read roughly the first 15 pages FOREVER and never reach the tail —
 * not late, never, and invisible because every individual run looks successful.
 *
 * WALL CLOCK IS THE BINDING CONSTRAINT, NOT THE RATE LIMIT. The first production
 * observe run took 57.7s for three merchants against the 60s Hobby ceiling, and
 * sex-eshop's 7,685-product walk truncated at 29 of 31 pages — on a laptop the
 * same walk finished 31 pages in 36.1s, so Vercel's iad1 round trip to Shopify is
 * materially slower (~1.42s/page vs ~1.16s). Hence: an OVERALL route budget as
 * well as a per-shop one, merchants walked cheapest-catalog-first, and any
 * merchant not reached reported explicitly as `not_reached` rather than silently
 * omitted. A single-shop call raises the per-shop budget automatically, which is
 * how a large catalog gets a complete single-pass walk.
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

/**
 * Stop starting new merchants at this point. Leaves ~12s of the 60s ceiling for
 * the in-flight shop to wind down at its own budget, its parity query, and the
 * response — measured against a first run that reached 57.7s.
 */
const ROUTE_BUDGET_MS = 48_000;

/** Per-shop budget when several merchants share one invocation. */
const MULTI_SHOP_BUDGET_MS = 22_000;

/**
 * Per-shop budget when the caller named a single shop. Nothing else competes for
 * the invocation, so a large catalog can complete in one pass: sex-eshop's 31
 * pages measured ~44s at Vercel's observed 1.42s/page.
 */
const SINGLE_SHOP_BUDGET_MS = 50_000;

/**
 * A cycle that has not completed within this window is restarted from the
 * beginning rather than resumed. Bounds the damage from a cursor Shopify no
 * longer accepts, or from a shop whose catalog keeps growing faster than one
 * cycle can walk it — either way, silently limping forever is the failure to
 * avoid.
 */
const CYCLE_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

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
  /** Rows actually read from enrichment_webhook_log, so an under-read is visible. */
  webhook_log_rows_read: number;
  reconcile_needs_work: number;
  /** Products both paths agree need work. */
  agreed: number;
  /** Edited in the window, reconcile says no work — with the reason for each. */
  webhook_only: number;
  webhook_only_by_reason: Record<string, number>;
  webhook_only_unexplained: string[];
  /**
   * The gate verdict for this shop. A truncated walk can never be `pass`: the
   * products it never read are indistinguishable from products it decided need
   * nothing, which is the same "could not look read as a factual negative"
   * defect Block 1 removed from the scanner.
   */
  verdict:
    | "pass"
    | "inconclusive_truncated_walk"
    | "inconclusive_webhook_log_read_incomplete"
    | "fail_unexplained_gap";
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
  const notReached: string[] = [];

  // Cheapest catalog first, so a shared invocation completes as many WHOLE walks
  // as it can instead of burning its whole budget truncating the largest one.
  // schema_enrichments row count is the only catalog-size proxy available without
  // an Admin API call; shops with none sort first, which is also where the
  // never-enriched merchants are.
  // head:true count per merchant, NOT a row pull. Pulling rows here would hit the
  // same silent PostgREST 1,000-row cap that inflated the enrichment queue, and
  // would skew the ordering for exactly the largest catalogs the ordering exists
  // to protect.
  const sizeHint = new Map<string, number>();
  await Promise.all(
    merchants.map(async (m: { id: string }) => {
      try {
        const { count } = await supabase
          .from("schema_enrichments")
          .select("id", { count: "exact", head: true })
          .eq("merchant_id", m.id);
        sizeHint.set(m.id, count ?? 0);
      } catch {
        // Ordering is an optimisation, never a correctness requirement.
      }
    }),
  );
  const ordered = [...merchants].sort(
    (a, b) => (sizeHint.get(a.id) ?? 0) - (sizeHint.get(b.id) ?? 0),
  );

  const perShopBudget =
    Number(url.searchParams.get("budget_ms")) ||
    (onlyShop ? SINGLE_SHOP_BUDGET_MS : MULTI_SHOP_BUDGET_MS);

  const resetCursor = url.searchParams.get("reset_cursor") === "1";

  for (const m of ordered) {
    // Never START a shop we cannot plausibly finish inside the ceiling. A
    // silently-omitted merchant would read as "nothing to do" for that shop.
    if (Date.now() - startedAt > ROUTE_BUDGET_MS) {
      notReached.push(m.shopify_domain);
      continue;
    }
    try {
      // Resume the in-progress cycle. An explicit ?after= always wins (operator
      // control); ?reset_cursor=1 forces a fresh cycle; and a cycle older than
      // CYCLE_STALE_AFTER_MS restarts rather than resuming forever.
      const state = await loadState(m.shopify_domain);
      const cycleStale =
        !!state?.cycle_started_at &&
        Date.now() - Date.parse(state.cycle_started_at) > CYCLE_STALE_AFTER_MS;
      const resumeFrom =
        (onlyShop && after) || (resetCursor || cycleStale ? null : state?.cursor ?? null);

      const rec = await reconcileCatalog({
        shopDomain: m.shopify_domain,
        merchantId: m.id,
        mode: scopeOk ? mode : "observe",
        after: resumeFrom,
        enqueueCap,
        maxPages,
        timeBudgetMs: Math.max(
          5_000,
          Math.min(perShopBudget, ROUTE_BUDGET_MS - (Date.now() - startedAt)),
        ),
      });

      // A walk that stopped mid-catalog leaves the cursor for the next run; one
      // that reached the end closes the cycle and stamps last_completed_at, the
      // only timestamp that licenses "the whole catalog has been seen".
      const cycleComplete = !rec.truncated && rec.nextCursor === null && rec.errors.length === 0;
      const nextState = await saveState({
        shopDomain: m.shopify_domain,
        cursor: cycleComplete ? null : rec.nextCursor,
        cycleComplete,
        startingFresh: resumeFrom === null,
        pagesDelta: rec.pagesWalked,
        productsDelta: rec.productsSeen,
        prior: state,
      });

      const parity = await buildParityReport({
        merchantId: m.id,
        windowHours,
        needsWork: rec.needsWork,
        noWork: rec.noWork,
        // Coverage, not per-invocation truncation, is what the verdict depends on.
        // Truncation is NORMAL for a large catalog now that the walk resumes, so
        // grading on it alone would mark every big shop inconclusive forever;
        // grading on cycle completion asks the right question.
        truncated: !cycleComplete,
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
        cycle_complete: cycleComplete,
        cycle_pages_walked: nextState.pages_walked_this_cycle,
        cycle_products_seen: nextState.products_seen_this_cycle,
        cycle_started_at: nextState.cycle_started_at,
        last_full_catalog_pass: nextState.last_completed_at,
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
    // Non-empty means this invocation did not cover every paid merchant. Re-run,
    // or call per shop with ?shop=. Never treat an absent shop as clean.
    not_reached: notReached,
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
  truncated: boolean;
}): Promise<ParityReport> {
  const cutoff = new Date(Date.now() - opts.windowHours * 3600_000).toISOString();

  // PAGINATED, and the pagination is load-bearing. PostgREST caps an unbounded
  // .select() at 1,000 rows, silently. The first 7-day run read 777 distinct
  // products where the table actually holds 4,250 rows / 2,941 distinct — and an
  // under-read of webhook_saw makes the gate look CLEANER than it is, because a
  // webhook-only product beyond the cap is never even considered for
  // webhook_only_unexplained. Exactly the "we could not look, reported as a
  // factual negative" defect, on the instrument rather than the subject. The 24h
  // window happened to sit under the cap (829 rows), so that verdict was correct
  // by luck, not by construction.
  const webhookSaw = new Set<string>();
  const PAGE = 1000;
  let logRowsRead = 0;
  let logReadTruncated = false;
  let logReadError: string | null = null;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from("enrichment_webhook_log")
      .select("product_id")
      .eq("merchant_id", opts.merchantId)
      .in("outcome", WEBHOOK_SAW_OUTCOMES)
      .gte("created_at", cutoff)
      .not("product_id", "is", null)
      .order("id", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) {
      logReadError = error.message;
      break;
    }
    const rows = data ?? [];
    logRowsRead += rows.length;
    for (const row of rows) if (row.product_id) webhookSaw.add(String(row.product_id));
    if (rows.length < PAGE) break;
    // Hard stop so a pathological log can never run the invocation into the
    // ceiling — but say so, because a capped read cannot support a pass.
    if (offset + PAGE >= 100_000) {
      logReadTruncated = true;
      break;
    }
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

  const unexplainedCount = byReason["not_in_walked_catalog"] ?? 0;
  return {
    verdict: opts.truncated
      ? "inconclusive_truncated_walk"
      : logReadTruncated || logReadError
        ? "inconclusive_webhook_log_read_incomplete"
        : unexplainedCount > 0
          ? "fail_unexplained_gap"
          : "pass",
    window_hours: opts.windowHours,
    webhook_saw: webhookSaw.size,
    webhook_log_rows_read: logRowsRead,
    reconcile_needs_work: needs.size,
    agreed,
    webhook_only: webhookSaw.size - agreed,
    webhook_only_by_reason: byReason,
    webhook_only_unexplained: unexplained,
    reconcile_only: needs.size - agreed,
  };
}

// ─── Cursor persistence ──────────────────────────────────────────────────────

interface ReconcileState {
  cursor: string | null;
  cycle_started_at: string | null;
  last_completed_at: string | null;
  pages_walked_this_cycle: number;
  products_seen_this_cycle: number;
}

const EMPTY_STATE: ReconcileState = {
  cursor: null,
  cycle_started_at: null,
  last_completed_at: null,
  pages_walked_this_cycle: 0,
  products_seen_this_cycle: 0,
};

/**
 * Best-effort. A failed read means "start from the beginning", which costs a
 * repeated walk but can never skip catalog — the safe direction.
 */
async function loadState(shopDomain: string): Promise<ReconcileState | null> {
  try {
    const { data, error } = await supabase
      .from("catalog_reconcile_state")
      .select(
        "cursor, cycle_started_at, last_completed_at, pages_walked_this_cycle, products_seen_this_cycle",
      )
      .eq("shop_domain", shopDomain)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data as ReconcileState | null) ?? null;
  } catch (err) {
    sentry.captureException(err, {
      tags: { area: "cron.reconcile-catalog", branch: "load_state" },
      extra: { shop: shopDomain },
    });
    return null;
  }
}

/**
 * Persist the resume point and the cycle counters. Returns the state as written
 * so the response reports what was actually saved rather than what was intended.
 */
async function saveState(opts: {
  shopDomain: string;
  cursor: string | null;
  cycleComplete: boolean;
  startingFresh: boolean;
  pagesDelta: number;
  productsDelta: number;
  prior: ReconcileState | null;
}): Promise<ReconcileState> {
  const nowIso = new Date().toISOString();
  const prior = opts.prior ?? EMPTY_STATE;

  const next: ReconcileState = opts.cycleComplete
    ? {
        cursor: null,
        cycle_started_at: null,
        last_completed_at: nowIso,
        pages_walked_this_cycle: 0,
        products_seen_this_cycle: 0,
      }
    : {
        cursor: opts.cursor,
        cycle_started_at: opts.startingFresh
          ? nowIso
          : prior.cycle_started_at ?? nowIso,
        last_completed_at: prior.last_completed_at,
        pages_walked_this_cycle:
          (opts.startingFresh ? 0 : prior.pages_walked_this_cycle) + opts.pagesDelta,
        products_seen_this_cycle:
          (opts.startingFresh ? 0 : prior.products_seen_this_cycle) + opts.productsDelta,
      };

  try {
    const { error } = await supabase.from("catalog_reconcile_state").upsert(
      { shop_domain: opts.shopDomain, ...next, updated_at: nowIso },
      { onConflict: "shop_domain" },
    );
    if (error) throw new Error(error.message);
  } catch (err) {
    // A lost cursor costs a restarted cycle, never skipped catalog.
    sentry.captureException(err, {
      tags: { area: "cron.reconcile-catalog", branch: "save_state" },
      extra: { shop: opts.shopDomain },
    });
  }
  return next;
}
