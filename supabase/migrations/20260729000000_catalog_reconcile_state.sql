-- ============================================================
-- catalog_reconcile_state — per-shop cursor for the catalog reconcile
-- 2026-07-29. Block 4.
--
-- WHY THIS EXISTS
--
-- The reconcile walks a catalog 250 products per page and is bounded by the 60s
-- Vercel Hobby function ceiling, so a large catalog does not fit in one
-- invocation: sex-eshop's 7,685 products take ~45s in 31 pages, against a 22s
-- per-shop budget when several merchants share a run.
--
-- Without a persisted cursor the walk restarts from page 1 every cycle, so on the
-- scheduled multi-shop run it would read roughly the first 15 pages forever and
-- **the tail of the catalog would never be reached at all**. Not late — never.
-- That is the difference between the cycle latency this switch accepts (~6h) and
-- an unbounded coverage hole, and it is invisible from the outside because each
-- individual run looks like it succeeded.
--
-- FK-FREE, deliberately, keyed on shop_domain rather than merchant_id — the same
-- reasoning as install_events (see 20260728120000). This is operational state
-- about a walk, not merchant data; if a merchant row is redacted the row here is
-- harmless and gets cleaned up by the reconcile skipping that shop. Nothing here
-- is PII: a shop domain, a Shopify cursor, timestamps and counters.
--
-- The cursor is a Shopify relay cursor and is NOT durable across catalog changes
-- in any guaranteed way; treat a stale or rejected cursor as "start over", never
-- as an error. `cycle_started_at` bounds that: a cycle older than the staleness
-- window is restarted from the beginning.
-- ============================================================

CREATE TABLE IF NOT EXISTS catalog_reconcile_state (
  shop_domain              TEXT PRIMARY KEY,

  -- Resume point for the in-progress cycle. NULL means "start at the beginning",
  -- which is also the state after a cycle completes.
  cursor                   TEXT,

  -- When the current cycle began its first page. Used to detect a cycle that has
  -- been limping for too long and should restart rather than resume.
  cycle_started_at         TIMESTAMPTZ,

  -- When a cycle last reached the END of the catalog. This is the only timestamp
  -- that licenses the claim "we have seen the whole catalog since then", and the
  -- parity gate reads it for exactly that reason.
  last_completed_at        TIMESTAMPTZ,

  -- Accumulated across the invocations of the CURRENT cycle, reset on completion,
  -- so "how much of the catalog has this cycle covered" is answerable mid-cycle.
  pages_walked_this_cycle  INT NOT NULL DEFAULT 0,
  products_seen_this_cycle INT NOT NULL DEFAULT 0,

  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Consistent with every other table here. The app connects with the service_role
-- key, which bypasses RLS; this is defence in depth for anon/authenticated.
ALTER TABLE catalog_reconcile_state ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE catalog_reconcile_state IS
  'Per-shop resume cursor for the catalog enrichment reconcile. Exists because a large catalog does not fit in one 60s invocation, and without a persisted cursor the walk would restart from page 1 every cycle and never reach the tail. FK-free on purpose (see the migration header).';

COMMENT ON COLUMN catalog_reconcile_state.last_completed_at IS
  'When a cycle last reached the end of the catalog. The only timestamp that supports "the whole catalog has been seen since then".';
