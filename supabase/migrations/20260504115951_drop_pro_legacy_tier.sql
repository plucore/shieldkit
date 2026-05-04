-- ShieldKit v2 — drop pro_legacy from merchants_tier_check
-- The 2 paying customers from v1 ($29 one-time) bought the v1 product they
-- received. They migrate to tier='free' along with everyone else; no perpetual
-- grandfathering. This narrows the constraint to the active v2 tiers.

ALTER TABLE merchants DROP CONSTRAINT IF EXISTS merchants_tier_check;
ALTER TABLE merchants
  ADD CONSTRAINT merchants_tier_check
  CHECK (tier IN ('free', 'shield', 'pro'));
