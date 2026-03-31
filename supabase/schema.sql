-- ============================================================
-- ShieldKit Supabase Schema
-- Run this in the Supabase SQL editor for your project.
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
-- ============================================================
CREATE TABLE IF NOT EXISTS merchants (
  id                     UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  shopify_domain         TEXT        NOT NULL UNIQUE,
  shop_name              TEXT,
  access_token_encrypted TEXT,
  tier                   TEXT        NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro')),
  billing_status         TEXT,
  scans_remaining        INTEGER     NOT NULL DEFAULT 1,
  policy_gen_count       INTEGER     NOT NULL DEFAULT 0,
  policy_gen_reset_at    TIMESTAMPTZ NOT NULL DEFAULT now() + interval '30 days',
  installed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  uninstalled_at         TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_merchants_domain       ON merchants(shopify_domain);
CREATE INDEX IF NOT EXISTS idx_merchants_active       ON merchants(uninstalled_at) WHERE uninstalled_at IS NULL;

ALTER TABLE merchants ENABLE ROW LEVEL SECURITY;

-- Merchants: each row is accessible only when the session's shop matches.
-- The server uses service_role (bypasses RLS); this policy guards anon/user key access.
CREATE POLICY "merchants_shop_isolation" ON merchants
  FOR ALL
  USING (shopify_domain = current_setting('app.current_shop', true));

-- ============================================================
-- TABLE: leads
-- Deduplication for welcome emails. One row per shop.
-- ============================================================
CREATE TABLE IF NOT EXISTS leads (
  id            UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  shop_domain   TEXT        NOT NULL UNIQUE,
  email         TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
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
CREATE INDEX IF NOT EXISTS idx_violations_severity  ON violations(severity);
CREATE INDEX IF NOT EXISTS idx_violations_raw_data  ON violations USING GIN(raw_data);

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
