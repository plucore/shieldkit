-- ShieldKit v2 — recurring billing migration
-- Source: SHIELDKIT-V2-TECHNICAL-PLAN.md (Phase 1)
-- Status: UNAPPLIED. Sections 6 and 7 are intentionally commented; run manually after code deploy.

-- 1. Migrate merchants table to recurring tiers
ALTER TABLE merchants DROP CONSTRAINT IF EXISTS merchants_tier_check;
ALTER TABLE merchants
  ADD CONSTRAINT merchants_tier_check
  CHECK (tier IN ('free', 'shield', 'pro', 'pro_legacy'));

-- 2. Monthly scan reset + billing fields
ALTER TABLE merchants
  ADD COLUMN IF NOT EXISTS scans_reset_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS billing_cycle TEXT CHECK (billing_cycle IN ('monthly','annual')),
  ADD COLUMN IF NOT EXISTS subscription_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS shopify_subscription_id TEXT;

-- 3. Digest email tracking
CREATE TABLE IF NOT EXISTS digest_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID REFERENCES merchants(id) ON DELETE CASCADE,
  sent_at TIMESTAMPTZ DEFAULT now(),
  scan_id UUID REFERENCES scans(id),
  new_issues_count INTEGER,
  fixes_confirmed_count INTEGER,
  email_provider_id TEXT
);
CREATE INDEX idx_digest_merchant_time ON digest_emails(merchant_id, sent_at DESC);

-- 4. Appeal letters
CREATE TABLE IF NOT EXISTS appeal_letters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID REFERENCES merchants(id) ON DELETE CASCADE,
  scan_id UUID REFERENCES scans(id),
  suspension_reason TEXT,
  generated_letter TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 5. Schema enrichment tracking (Pro)
CREATE TABLE IF NOT EXISTS schema_enrichments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID REFERENCES merchants(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL,
  enriched_fields TEXT[],
  metafield_values JSONB,
  enriched_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(merchant_id, product_id)
);
CREATE INDEX idx_schema_enrich_merchant ON schema_enrichments(merchant_id, enriched_at DESC);

-- 6. Grandfather the 2 paying customers (verify domains in production before running)
-- Run this AFTER deploying the code that recognizes 'pro_legacy'
-- UPDATE merchants
--   SET tier = 'pro_legacy', scans_remaining = NULL
--   WHERE shopify_domain IN ('normae-domain.myshopify.com', 'glamourous-grace-domain.myshopify.com');

-- 7. Migrate 11 free-tier merchants to fresh monthly quota
-- UPDATE merchants
--   SET scans_remaining = 1, scans_reset_at = now()
--   WHERE tier = 'free';
