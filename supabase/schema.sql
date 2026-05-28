-- ============================================================
-- ShieldKit Supabase Schema
-- Run this in the Supabase SQL editor when bootstrapping a new project.
--
-- This file represents the CUMULATIVE state of the production schema as
-- of 2026-05-27 (Fix 10 of the bug-fix sweep). For incremental changes
-- always create a numbered migration in supabase/migrations/ — never edit
-- the live DB through this file. The migrations are the source of truth
-- for ordering; this file is the source of truth for "what shape would I
-- get bootstrapping from scratch".
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- TABLE: sessions
-- Replaces the Prisma Session model for Shopify OAuth sessions.
-- accessToken and refreshToken are stored AES-256-GCM encrypted.
-- ============================================================
CREATE TABLE IF NOT EXISTS sessions (
  id                    TEXT        NOT NULL PRIMARY KEY,
  shop                  TEXT        NOT NULL,
  state                 TEXT        NOT NULL,
  is_online             BOOLEAN     NOT NULL DEFAULT false,
  scope                 TEXT,
  expires               TIMESTAMPTZ,
  access_token          TEXT        NOT NULL DEFAULT '',
  user_id               BIGINT,
  first_name            TEXT,
  last_name             TEXT,
  email                 TEXT,
  account_owner         BOOLEAN     NOT NULL DEFAULT false,
  locale                TEXT,
  collaborator          BOOLEAN              DEFAULT false,
  email_verified        BOOLEAN              DEFAULT false,
  refresh_token         TEXT,
  refresh_token_expires TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sessions_shop ON sessions(shop);

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
-- Service role bypasses RLS by default. Sessions are server-only;
-- no anon/authenticated policies are intentionally created.

-- ============================================================
-- TABLE: merchants
-- One row per installed shop. Soft-deleted on uninstall,
-- hard-deleted after GDPR shop/redact (48h post-uninstall).
--
-- tier CHECK widened by migration 20260514150228 to support v3 pricing
-- (monitoring, recovery) alongside grandfathered shield + pro. See
-- app/lib/billing/plans.ts hasMonitoringAccess / hasRecoveryAccess for
-- the canonical feature-gating helpers — never compare tier to literals
-- at call sites.
-- ============================================================
CREATE TABLE IF NOT EXISTS merchants (
  id                            UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  shopify_domain                TEXT        NOT NULL UNIQUE,
  access_token_encrypted        TEXT,
  tier                          TEXT        NOT NULL DEFAULT 'free'
                                   CHECK (tier IN ('free', 'shield', 'pro', 'monitoring', 'recovery')),
  -- scans_remaining is NULL on paid (unlimited), 0 when exhausted, n>0 when allowed
  scans_remaining               INTEGER     DEFAULT 1,
  scans_reset_at                TIMESTAMPTZ DEFAULT now(),
  -- billing fields (v2/v3 managed pricing)
  billing_cycle                 TEXT        CHECK (billing_cycle IN ('monthly','annual')),
  subscription_started_at       TIMESTAMPTZ,
  shopify_subscription_id       TEXT,
  -- monitoring-access settings (column name predates the v3 rebrand; backs
  -- /app/pro-settings + /app/bots/toggle)
  pro_settings                  JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- JSON-LD theme extension state
  -- (Fix 3 split intent from verified state; enabled flips only after
  -- positive verification by app/lib/json-ld-verifier.server.ts)
  json_ld_enabled               BOOLEAN     NOT NULL DEFAULT false,
  json_ld_enable_clicked_at     TIMESTAMPTZ,
  json_ld_verified_at           TIMESTAMPTZ,
  json_ld_verification_attempts INT         NOT NULL DEFAULT 0,
  -- AI policy generation (any paid tier — v4 single paid gate via
  -- hasPaidAccess). policy_regen_used caps regeneration per policy type
  -- at 2 (initial + 1 regen). The wider monthly cap below is the abuse
  -- ceiling.
  generated_policies            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  policy_regen_used             JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- AI usage cap (v4 §5) — shared across policy generation + appeal
  -- letter generation. 12 generations per rolling 30-day window.
  -- Enforced atomically by consume_ai_credit() below.
  ai_generations_used           INT         NOT NULL DEFAULT 0,
  ai_generations_reset_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Review prompt + freshness signals
  review_prompted               BOOLEAN     NOT NULL DEFAULT false,
  llms_txt_last_served_at       TIMESTAMPTZ,
  -- Shopify-sourced metadata (opportunistically refreshed by every scan;
  -- NULL on rows that haven't scanned since this set was wired in).
  shop_name                     TEXT,
  shop_owner_name               TEXT,
  contact_email                 TEXT,
  country                       TEXT,
  province                      TEXT,
  city                          TEXT,
  currency_code                 TEXT,
  shopify_plan                  TEXT,
  primary_domain                TEXT,
  shop_created_at               TIMESTAMPTZ,
  iana_timezone                 TEXT,
  shop_metadata_refreshed_at    TIMESTAMPTZ,
  -- Install lifecycle
  installed_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  uninstalled_at                TIMESTAMPTZ,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_merchants_domain    ON merchants(shopify_domain);
CREATE INDEX IF NOT EXISTS idx_merchants_active    ON merchants(uninstalled_at) WHERE uninstalled_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_merchants_country   ON merchants(country) WHERE uninstalled_at IS NULL;

ALTER TABLE merchants ENABLE ROW LEVEL SECURITY;

-- Merchants: each row is accessible only when the session's shop matches.
-- The server uses service_role (bypasses RLS); this policy guards anon/user key access.
CREATE POLICY "merchants_shop_isolation" ON merchants
  FOR ALL
  USING (shopify_domain = current_setting('app.current_shop', true));

-- ============================================================
-- TABLE: leads
-- Lead collection for future retargeting. One row per shop.
-- ============================================================
CREATE TABLE IF NOT EXISTS leads (
  id                UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  shop_domain       TEXT        NOT NULL UNIQUE,
  email             TEXT        NOT NULL,
  public_risk_score INT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE leads ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- TABLE: scans
-- Each compliance scan run for a merchant.
-- ============================================================
CREATE TABLE IF NOT EXISTS scans (
  id               UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  merchant_id      UUID        NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  scan_type        TEXT        NOT NULL DEFAULT 'manual' CHECK (scan_type IN ('manual', 'automated')),
  compliance_score NUMERIC(5,2),
  total_checks     INTEGER,
  passed_checks    INTEGER,
  critical_count   INTEGER,
  warning_count    INTEGER,
  info_count       INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scans_merchant_id ON scans(merchant_id);
CREATE INDEX IF NOT EXISTS idx_scans_created_at  ON scans(created_at DESC);

ALTER TABLE scans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "scans_merchant_isolation" ON scans
  FOR ALL
  USING (
    merchant_id IN (
      SELECT id FROM merchants
      WHERE shopify_domain = current_setting('app.current_shop', true)
    )
  );

-- ============================================================
-- TABLE: violations
-- Individual check results within a scan.
-- ============================================================
CREATE TABLE IF NOT EXISTS violations (
  id              UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  scan_id         UUID        NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  check_name      TEXT        NOT NULL,
  passed          BOOLEAN     NOT NULL DEFAULT false,
  severity        TEXT        NOT NULL CHECK (severity IN ('critical', 'warning', 'info', 'error')),
  title           TEXT,
  description     TEXT,
  fix_instruction TEXT,
  raw_data        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_violations_scan_id  ON violations(scan_id);
CREATE INDEX IF NOT EXISTS idx_violations_severity ON violations(severity);
CREATE INDEX IF NOT EXISTS idx_violations_raw_data ON violations USING GIN(raw_data);

ALTER TABLE violations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "violations_merchant_isolation" ON violations
  FOR ALL
  USING (
    scan_id IN (
      SELECT s.id FROM scans s
      JOIN merchants m ON m.id = s.merchant_id
      WHERE m.shopify_domain = current_setting('app.current_shop', true)
    )
  );

-- ============================================================
-- TABLE: scan_rate_limits
-- Persistent rate limiting for scan API requests.
-- ============================================================
CREATE TABLE IF NOT EXISTS scan_rate_limits (
  id           UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  shop         TEXT        NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_shop_time ON scan_rate_limits(shop, requested_at);

ALTER TABLE scan_rate_limits ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- FUNCTION: decrement_scan_quota
-- Atomically decrements scans_remaining for a merchant.
-- Returns the new scans_remaining value, or no rows if quota
-- was already exhausted (scans_remaining <= 0).
-- Merchants with NULL scans_remaining (paid/unlimited) are
-- not affected — callers should skip this RPC for them.
-- ============================================================
CREATE OR REPLACE FUNCTION decrement_scan_quota(p_merchant_id UUID)
RETURNS TABLE(new_scans_remaining INTEGER) AS $$
  UPDATE merchants
  SET scans_remaining = scans_remaining - 1
  WHERE id = p_merchant_id
    AND scans_remaining IS NOT NULL
    AND scans_remaining > 0
  RETURNING scans_remaining AS new_scans_remaining;
$$ LANGUAGE sql;

-- ============================================================
-- FUNCTION: consume_ai_credit (v4 §5)
-- Atomically increments ai_generations_used (resetting the window
-- if reset_at is >30 days old). Returns one row with the new counter
-- + window on success; zero rows if the cap is already exhausted in
-- the current window.
--
-- The single-statement UPDATE with branching CASE eliminates the
-- read-modify-write race two parallel AI-generation actions could
-- otherwise create.
-- ============================================================
CREATE OR REPLACE FUNCTION consume_ai_credit(p_merchant_id UUID, p_cap INT)
RETURNS TABLE(new_used INT, reset_at TIMESTAMPTZ) AS $$
  UPDATE merchants
  SET
    ai_generations_used = CASE
      WHEN ai_generations_reset_at < now() - INTERVAL '30 days' THEN 1
      ELSE ai_generations_used + 1
    END,
    ai_generations_reset_at = CASE
      WHEN ai_generations_reset_at < now() - INTERVAL '30 days' THEN now()
      ELSE ai_generations_reset_at
    END
  WHERE id = p_merchant_id
    AND (
      ai_generations_reset_at < now() - INTERVAL '30 days'
      OR ai_generations_used < p_cap
    )
  RETURNING ai_generations_used AS new_used,
            ai_generations_reset_at AS reset_at;
$$ LANGUAGE sql;

-- scans_remaining NULL = unlimited (paid).
-- Original schema had NOT NULL which broke paid upgrades; left here as a
-- defensive no-op for bootstrap correctness.
ALTER TABLE merchants
  ALTER COLUMN scans_remaining DROP NOT NULL;

-- ============================================================
-- TABLE: digest_emails
-- Audit log of weekly digest sends (v2 recurring billing migration).
-- email_provider_id: Resend message id on success, 'FAILED:<reason>'
-- on failure including 'FAILED:no_email_on_file'.
-- ============================================================
CREATE TABLE IF NOT EXISTS digest_emails (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id           UUID        REFERENCES merchants(id) ON DELETE CASCADE,
  sent_at               TIMESTAMPTZ DEFAULT now(),
  scan_id               UUID        REFERENCES scans(id),
  new_issues_count      INTEGER,
  fixes_confirmed_count INTEGER,
  email_provider_id     TEXT
);

CREATE INDEX IF NOT EXISTS idx_digest_merchant_time
  ON digest_emails(merchant_id, sent_at DESC);

-- ============================================================
-- TABLE: appeal_letters
-- GMC re-review appeal letter generations (Recovery feature).
-- Capped at 3 per scan_id via row counting in the route handler.
-- ============================================================
CREATE TABLE IF NOT EXISTS appeal_letters (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id       UUID        REFERENCES merchants(id) ON DELETE CASCADE,
  scan_id           UUID        REFERENCES scans(id),
  suspension_reason TEXT,
  generated_letter  TEXT,
  created_at        TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- TABLE: schema_enrichments
-- Per-product GTIN/MPN/brand enrichment audit log.
-- One row per (merchant_id, product_id); the unique constraint also
-- backs the enrichment dedup queries in webhooks.products.update.tsx
-- and api.cron.process-scan-triggers.ts (Fix 9).
-- ============================================================
CREATE TABLE IF NOT EXISTS schema_enrichments (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id      UUID        REFERENCES merchants(id) ON DELETE CASCADE,
  product_id       BIGINT      NOT NULL,
  enriched_fields  TEXT[],
  metafield_values JSONB,
  enriched_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(merchant_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_schema_enrich_merchant
  ON schema_enrichments(merchant_id, enriched_at DESC);

-- ============================================================
-- TABLE: enrichment_webhook_log
-- One row per products/update webhook delivery. outcome ∈
-- enriched | noop | enqueued | skip_tier | skip_scope | skip_dedup |
-- skip_already_queued | skip_no_merchant | skip_no_product_id |
-- skip_no_admin | skip_uninstalled | error. merchant_id is UUID
-- (matches merchants.id) — earlier draft schema mistakenly typed it
-- as BIGINT.
-- ============================================================
CREATE TABLE IF NOT EXISTS enrichment_webhook_log (
  id            BIGSERIAL    PRIMARY KEY,
  merchant_id   UUID         REFERENCES merchants(id),
  product_id    TEXT,
  topic         TEXT,
  outcome       TEXT,
  written_keys  TEXT[],
  error_message TEXT,
  created_at    TIMESTAMPTZ  DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_enrichment_log_merchant_created
  ON enrichment_webhook_log(merchant_id, created_at DESC);

-- ============================================================
-- TABLE: llms_txt_requests
-- AI visibility tracking. One row per llms.txt request served.
-- crawler_name is normalised via app/lib/ai-visibility/identify-crawler;
-- ip_hash is sha256 of the IP with the last octet (v4) / 64 bits (v6)
-- stripped before hashing for privacy.
-- ============================================================
CREATE TABLE IF NOT EXISTS llms_txt_requests (
  id           BIGSERIAL    PRIMARY KEY,
  shop_domain  TEXT         NOT NULL,
  merchant_id  UUID         REFERENCES merchants(id),
  user_agent   TEXT,
  crawler_name TEXT,
  ip_hash      TEXT,
  created_at   TIMESTAMPTZ  DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_llms_requests_shop_created
  ON llms_txt_requests(shop_domain, created_at DESC);

-- ============================================================
-- TABLE: pending_scan_triggers
-- Storefront-monitoring scan-on-change queue.
-- Inserted by webhooks.themes.update + webhooks.products.update + the
-- weekly-scan cron. Drained one row per tick by
-- api.cron.process-scan-triggers (GitHub Actions, every 30 min).
--
-- trigger_type values: weekly_scan | theme_update | theme_publish |
-- product_update | enrichment.
--
-- week_iso (Fix 8): set only by the weekly-scan cron so retries are
-- idempotent within the same ISO week. The partial unique index excludes
-- event-driven rows (week_iso IS NULL) so they keep their existing 24h
-- "already queued" dedup logic.
--
-- payload (Fix 9): per-trigger context, currently only set for
-- trigger_type='enrichment' as { product_gid, numeric_product_id }.
-- ============================================================
CREATE TABLE IF NOT EXISTS pending_scan_triggers (
  id           BIGSERIAL    PRIMARY KEY,
  merchant_id  UUID         REFERENCES merchants(id),
  trigger_type TEXT,
  week_iso     TEXT,
  payload      JSONB,
  trigger_at   TIMESTAMPTZ  DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pending_scans_unprocessed
  ON pending_scan_triggers(merchant_id, processed_at)
  WHERE processed_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_scan_triggers_week
  ON pending_scan_triggers (merchant_id, trigger_type, week_iso)
  WHERE week_iso IS NOT NULL;

-- ============================================================
-- TABLE: webhook_failures
-- Audit + retry-queue table for webhook deliveries whose side-effects
-- failed. Today only app/uninstalled writes to this table (Fix 4 —
-- 2026-05-27 audit). The reconcile-installs cron walks still-installed
-- merchants daily and inserts a synthetic row stamped resolved_at=now()
-- when it back-fills uninstalled_at from a probe-revealed 401.
-- ============================================================
CREATE TABLE IF NOT EXISTS webhook_failures (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  topic         TEXT         NOT NULL,
  shop          TEXT         NOT NULL,
  payload       JSONB,
  error_message TEXT,
  resolved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_failures_unresolved
  ON webhook_failures (topic, shop)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_webhook_failures_created_at
  ON webhook_failures (created_at DESC);
