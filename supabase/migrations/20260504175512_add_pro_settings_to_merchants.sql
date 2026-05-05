-- ShieldKit v2 — add pro_settings JSONB column to merchants
--
-- Backs the Shield Max settings form (/app/pro-settings) and the AI bot
-- preferences toggle (/app/bots/toggle). Until this migration ships, both
-- routes render a warning banner and refuse to persist.
--
-- Backfills NULLs to '{}'::jsonb so downstream code can spread freely
-- without null-checking.

ALTER TABLE merchants
  ADD COLUMN IF NOT EXISTS pro_settings JSONB DEFAULT '{}'::jsonb;

UPDATE merchants
  SET pro_settings = '{}'::jsonb
  WHERE pro_settings IS NULL;
