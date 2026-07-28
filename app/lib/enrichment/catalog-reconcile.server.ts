/**
 * app/lib/enrichment/catalog-reconcile.server.ts
 *
 * Catalog reconcile — the replacement for products/create + products/update as
 * the DISCOVERY mechanism for GTIN/MPN/brand enrichment.
 *
 * WHY REPLACE WEBHOOK DISCOVERY
 *
 * The webhook path fires on every product edit whether or not enrichment is
 * needed. One free store generated ~16.7k deliveries/day; across July the
 * measured redundancy was ~2.37 deliveries per product. Each delivery costs a
 * serverless invocation, an HMAC verification and two Supabase reads, and then
 * the drainer pays a further per-product Admin API round trip just to discover
 * there is nothing to write. Discovery by paging inverts that: it reads the
 * fields it needs for 250 products in ONE request and enqueues only products
 * that genuinely need a write.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not write metafields. Discovery and enforcement stay separate: this
 * enqueues `pending_scan_triggers` rows exactly as the webhook does, and
 * api.cron.process-scan-triggers.ts remains the single writer. That keeps the
 * change to ONE variable — how products are found — which is what makes the
 * parity comparison in the Block 4 gate meaningful.
 *
 * MEASUREMENTS BEHIND THE CONSTANTS (production, 2026-07-28)
 *
 *   sex-eshop.myshopify.com   7,685 products   31 pages   36.1s   cost 2,431 total
 *   9973f3-3.myshopify.com    1,650 products    7 pages   12.6s   cost   729 total
 *   shieldkit-test-stor        17 products      1 page     0.3s   cost     6 total
 *
 * PAGE_SIZE = 250 is confirmed feasible, not assumed. A single
 * products(first: 250) page carrying variants(first:1) plus the custom-namespace
 * metafields connection measured requestedQueryCost 112 / actualQueryCost 79
 * against a 2,000-point bucket refilling at 100/s — the rate limit is nowhere
 * near binding, and cost barely scales with `first` (60 products cost 66, 250
 * cost 79). Cursor-based paging is therefore the whole story; the binding
 * constraint is the 60s Vercel Hobby function ceiling, which is why the walk is
 * wall-clock budgeted and returns its cursor instead of assuming one pass fits.
 */

import { supabase } from "../../supabase.server";
import { createAdminClient } from "../shopify-api.server";
import {
  decideEnrichment,
  snapshotFromNode,
  type EnrichmentDecision,
  type EnrichmentSnapshot,
} from "./enrichment-decision.server";

/**
 * Shopify's maximum `first` on a connection. Verified reachable for this exact
 * query shape — see the cost measurements in the header.
 */
export const PAGE_SIZE = 250;

/**
 * Stop admitting new pages at this point so the caller can still finish its
 * inserts and respond inside the 60s Hobby ceiling. sex-eshop's full 31-page
 * walk measured 36.1s, so a single invocation covers the largest live catalog
 * with headroom — but a catalog twice that size would not, hence the budget and
 * the returned cursor.
 */
export const RECONCILE_TIME_BUDGET_MS = 40_000;

/** Same 24h dedup window the webhook path uses against schema_enrichments. */
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

const CATALOG_PAGE_QUERY = /* GraphQL */ `
  query CatalogReconcilePage($n: Int!, $after: String) {
    products(first: $n, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        vendor
        updatedAt
        variants(first: 1) {
          nodes {
            sku
            barcode
          }
        }
        metafields(namespace: "custom", first: 10) {
          nodes {
            key
            value
          }
        }
      }
    }
  }
`;

const SHOP_NAME_QUERY = /* GraphQL */ `
  query ReconcileShopName {
    shop {
      name
    }
  }
`;

interface CatalogPageResponse {
  products: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{
      id: string;
      vendor: string | null;
      updatedAt: string;
      variants: { nodes: Array<{ sku: string | null; barcode: string | null }> } | null;
      metafields: { nodes: Array<{ key: string; value: string }> } | null;
    }>;
  };
}

/** What the reconcile concluded about one product. */
export interface ReconciledProduct {
  productGid: string;
  numericProductId: string;
  updatedAt: string;
  /** Keys the drainer would write, in gtin/mpn/brand order. */
  wouldWrite: string[];
  reason: "needs_write" | "already_complete" | "no_signal" | "opted_out" | "dedup_fresh";
}

export interface ReconcileResult {
  shopDomain: string;
  merchantId: string;
  /**
   * `observe` reads and decides but writes NOTHING anywhere — the mode the
   * parallel run uses. `enqueue` additionally inserts pending_scan_triggers.
   */
  mode: "observe" | "enqueue";
  pagesWalked: number;
  productsSeen: number;
  /** Products the drainer would have real work for. */
  needsWork: ReconciledProduct[];
  /** Everything else, kept so the parity comparison can explain each divergence. */
  noWork: ReconciledProduct[];
  enqueued: number;
  skippedDedupFresh: number;
  /** True when the wall-clock budget stopped the walk before the last page. */
  truncated: boolean;
  /** Resume point when truncated. */
  nextCursor: string | null;
  elapsedMs: number;
  totalActualQueryCost: number;
  errors: string[];
}

export interface ReconcileOptions {
  shopDomain: string;
  merchantId: string;
  mode: "observe" | "enqueue";
  /** Resume from a previous truncated pass. */
  after?: string | null;
  /** Cap on rows inserted in `enqueue` mode. Ignored in `observe`. */
  enqueueCap?: number;
  timeBudgetMs?: number;
  /** Page cap, for tests and bounded manual runs. */
  maxPages?: number;
}

function numericId(gid: string): string | null {
  const m = gid.match(/\/(\d+)$/);
  return m ? m[1] : null;
}

/**
 * Walk a shop's catalog and decide, per product, whether enrichment is needed —
 * using only the fields already carried in the page response, so there is no
 * per-product round trip.
 *
 * Never throws: a failed page ends the walk with `errors` populated and whatever
 * was already decided intact, so a partial pass is still usable evidence.
 */
export async function reconcileCatalog(
  opts: ReconcileOptions,
): Promise<ReconcileResult> {
  const startedAt = Date.now();
  const timeBudget = opts.timeBudgetMs ?? RECONCILE_TIME_BUDGET_MS;
  const result: ReconcileResult = {
    shopDomain: opts.shopDomain,
    merchantId: opts.merchantId,
    mode: opts.mode,
    pagesWalked: 0,
    productsSeen: 0,
    needsWork: [],
    noWork: [],
    enqueued: 0,
    skippedDedupFresh: 0,
    truncated: false,
    nextCursor: null,
    elapsedMs: 0,
    totalActualQueryCost: 0,
    errors: [],
  };

  let executor;
  try {
    executor = await createAdminClient(opts.shopDomain);
  } catch (err) {
    result.errors.push(
      `admin_client: ${err instanceof Error ? err.message : String(err)}`,
    );
    result.elapsedMs = Date.now() - startedAt;
    return result;
  }

  // ── Shop name, once per pass ───────────────────────────────────────────────
  // The per-product path fetches this lazily per product that needs it; here one
  // query serves the whole catalog. Same value, same fallback chain.
  let shopName: string | null = null;
  try {
    const res = await executor<{ shop: { name: string | null } }>(SHOP_NAME_QUERY);
    shopName = res.data?.shop?.name ?? null;
  } catch (err) {
    // Non-fatal: brand then falls back to vendor only, and a product with
    // neither is reported as no_signal rather than being wrongly enqueued.
    result.errors.push(
      `shop_name: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── Dedup anchors, once per pass ──────────────────────────────────────────
  // The webhook path reads schema_enrichments per product to honour a 24h dedup
  // window. One ranged read here gives the same answer for the whole catalog.
  const freshCutoff = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString();
  const freshlyEnriched = new Set<string>();
  try {
    const { data, error } = await supabase
      .from("schema_enrichments")
      .select("product_id")
      .eq("merchant_id", opts.merchantId)
      .gte("enriched_at", freshCutoff);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) freshlyEnriched.add(String(row.product_id));
  } catch (err) {
    // Fail toward doing the work: a missed dedup costs a redundant enrichment,
    // a wrongly-applied one silently skips a product that needed writing.
    result.errors.push(
      `dedup_anchors: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Already-queued unprocessed enrichment rows, so a second pass before the
  // drainer catches up does not double-enqueue. Same intent as the webhook's
  // skip_already_queued branch, one query instead of one per product.
  const alreadyQueued = new Set<string>();
  try {
    const { data, error } = await supabase
      .from("pending_scan_triggers")
      .select("payload")
      .eq("merchant_id", opts.merchantId)
      .eq("trigger_type", "enrichment")
      .is("processed_at", null);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) {
      const pid = (row.payload as { numeric_product_id?: string } | null)
        ?.numeric_product_id;
      if (pid) alreadyQueued.add(String(pid));
    }
  } catch (err) {
    result.errors.push(
      `queued_anchors: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── The walk ──────────────────────────────────────────────────────────────
  let after: string | null = opts.after ?? null;
  const pending: Array<{ merchant_id: string; trigger_type: string; payload: unknown }> = [];

  for (;;) {
    if (Date.now() - startedAt > timeBudget) {
      result.truncated = true;
      result.nextCursor = after;
      break;
    }
    if (opts.maxPages && result.pagesWalked >= opts.maxPages) {
      result.truncated = true;
      result.nextCursor = after;
      break;
    }

    let page: CatalogPageResponse["products"];
    try {
      const res = await executor<CatalogPageResponse>(CATALOG_PAGE_QUERY, {
        n: PAGE_SIZE,
        after,
      });
      if (res.errors?.length) {
        throw new Error(res.errors.map((e) => e.message).join("; "));
      }
      if (!res.data?.products) throw new Error("no_products_in_response");
      page = res.data.products;
      result.totalActualQueryCost += res.extensions?.cost?.actualQueryCost ?? 0;
    } catch (err) {
      // A failed page is "we could not look", never "the catalog ends here".
      // Record the cursor so the next pass resumes rather than restarting, and
      // mark truncated so a caller can never read a partial walk as complete.
      result.errors.push(
        `page ${result.pagesWalked + 1}: ${err instanceof Error ? err.message : String(err)}`,
      );
      result.truncated = true;
      result.nextCursor = after;
      break;
    }

    result.pagesWalked += 1;

    for (const node of page.nodes) {
      result.productsSeen += 1;
      const pid = numericId(node.id);
      if (!pid) continue;

      const snap: EnrichmentSnapshot = snapshotFromNode(node);
      const decision: EnrichmentDecision = decideEnrichment(snap, shopName);
      const wouldWrite = decision.writes.map((w) => w.key);

      const record: ReconciledProduct = {
        productGid: node.id,
        numericProductId: pid,
        updatedAt: node.updatedAt,
        wouldWrite,
        // "already_complete" must mean the three keys are SET — not merely that
        // all three were skipped. A product with no barcode, no SKU, no vendor
        // and no shop-name fallback also skips all three, and calling that
        // complete would report an un-enrichable product as a finished one.
        reason: decision.optedOut
          ? "opted_out"
          : wouldWrite.length > 0
            ? "needs_write"
            : ["gtin", "mpn", "brand"].every((k) => snap.existing[k])
              ? "already_complete"
              : "no_signal",
      };

      if (decision.optedOut || wouldWrite.length === 0) {
        result.noWork.push(record);
        continue;
      }

      // Freshly enriched within the dedup window — real work, but not yet.
      if (freshlyEnriched.has(pid)) {
        result.skippedDedupFresh += 1;
        result.noWork.push({ ...record, reason: "dedup_fresh" });
        continue;
      }

      result.needsWork.push(record);

      if (opts.mode === "enqueue" && !alreadyQueued.has(pid)) {
        if (!opts.enqueueCap || pending.length < opts.enqueueCap) {
          pending.push({
            merchant_id: opts.merchantId,
            trigger_type: "enrichment",
            payload: { product_gid: node.id, numeric_product_id: pid },
          });
          alreadyQueued.add(pid);
        }
      }
    }

    if (!page.pageInfo.hasNextPage) {
      result.nextCursor = null;
      break;
    }
    after = page.pageInfo.endCursor;
  }

  // ── Enqueue, in one batched insert ────────────────────────────────────────
  if (opts.mode === "enqueue" && pending.length > 0) {
    // Chunked so a very large first pass cannot exceed a single statement's
    // practical payload size.
    for (let i = 0; i < pending.length; i += 500) {
      const chunk = pending.slice(i, i + 500);
      const { error } = await supabase.from("pending_scan_triggers").insert(chunk);
      if (error) {
        result.errors.push(`enqueue: ${error.message}`);
        break;
      }
      result.enqueued += chunk.length;
    }
  }

  result.elapsedMs = Date.now() - startedAt;
  return result;
}
