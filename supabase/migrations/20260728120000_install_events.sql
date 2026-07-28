-- ============================================================
-- install_events — append-only merchant lifecycle ledger
-- 2026-07-28. Data-integrity audit, Issue 2 (CRITICAL).
--
-- WHY THIS TABLE EXISTS
--
-- Churn was 100% unmeasurable. Not because the app/uninstalled webhook fails —
-- it works — but because Shopify's GDPR shop/redact webhook fires 48h after
-- every uninstall and app/routes/webhooks.shop.redact.tsx hard-deletes the
-- merchants row, cascading to all 7 child tables. merchants.uninstalled_at is
-- therefore a column with a 48-hour half-life on a row scheduled for deletion:
-- a point-in-time query can essentially never observe a non-NULL value, which
-- is exactly what the audit found (0 of 54 rows, against ~40 real uninstalls
-- reconstructed from orphaned `leads` rows).
--
-- THE ONE RULE: **NO FOREIGN KEY TO merchants.**
--
-- Every one of the 7 existing child tables declares
-- `REFERENCES merchants(id) ON DELETE CASCADE`, and that is precisely why none
-- of them survived to record the churn. If a future migration "tidies up" this
-- table by adding an FK on merchant_id, it will silently destroy the ledger the
-- next time a shop is redacted. merchant_id below is an intentionally
-- unconstrained UUID: it is a convenience join key while the merchant row
-- exists, and a dangling historical reference afterwards. That is correct.
--
-- GDPR POSTURE (deliberate, please read before changing)
--
-- This table is designed to survive shop/redact, so its contents must stay
-- proportionate. It stores only: the shop domain (a business identifier), the
-- lifecycle event, a timestamp, and the plan tier. It deliberately does NOT
-- store the merchant's email, owner name, billing address, or any catalog data
-- — all of which remain subject to the existing cascade delete. Keep it that
-- way; do not add PII columns here. If a stricter posture is ever required,
-- replace shop_domain with a salted hash rather than dropping the table.
--
-- Note the `leads` table currently serves as an accidental churn ledger (it has
-- no FK, so it also survives redact) AND holds merchant email addresses. Once
-- this table has enough history to replace it, `leads` should be pruned on
-- redact — but NOT before, or the only historical churn record is lost.
-- ============================================================

CREATE TABLE IF NOT EXISTS install_events (
  id           BIGSERIAL PRIMARY KEY,

  -- The durable identity. Survives the merchant row by design.
  shop_domain  TEXT NOT NULL,

  -- 'install'  — a completed offline-token exchange for a shop with no prior
  --              live merchant row, or a reinstall. Written from afterAuth.
  -- 'uninstall'— app/uninstalled webhook received. The real churn event.
  -- 'redact'   — shop/redact received; the merchants row is about to be
  --              hard-deleted. Recorded separately so "uninstalled" and
  --              "uninstalled and purged" stay distinguishable, and so a redact
  --              arriving without a preceding uninstall (a delivery we missed)
  --              is visible rather than silent.
  event_type   TEXT NOT NULL CHECK (event_type IN ('install', 'uninstall', 'redact')),

  -- Plan tier at the moment of the event. NULL when unknown (e.g. the merchant
  -- row was already gone). This is what makes free-churn vs paid-churn
  -- separable, which is the whole point for conversion/retention analysis.
  tier         TEXT,

  -- Unconstrained on purpose. See "THE ONE RULE" above.
  merchant_id  UUID,

  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Room for context without schema churn (e.g. billing_cycle, source).
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Primary access pattern: per-shop lifecycle timeline, newest first.
CREATE INDEX IF NOT EXISTS idx_install_events_shop
  ON install_events (shop_domain, occurred_at DESC);

-- Cohort/funnel aggregation: "all uninstalls in month X".
CREATE INDEX IF NOT EXISTS idx_install_events_type_time
  ON install_events (event_type, occurred_at);

-- Consistent with every other table in this schema. The app connects with the
-- service_role key, which bypasses RLS; this is defence in depth for the anon
-- and authenticated roles, which must never read the lifecycle ledger.
ALTER TABLE install_events ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE install_events IS
  'Append-only merchant lifecycle ledger (install/uninstall/redact). Intentionally has NO foreign key to merchants: it must survive the shop/redact cascade that deletes the merchant row 48h after uninstall. Adding an FK here would destroy the churn history. See the migration header before modifying.';

COMMENT ON COLUMN install_events.merchant_id IS
  'Unconstrained UUID, NOT a foreign key. Dangles by design once the merchant row is redacted.';
