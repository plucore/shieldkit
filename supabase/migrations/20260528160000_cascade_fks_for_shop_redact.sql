-- 20260528160000_cascade_fks_for_shop_redact.sql
--
-- GDPR shop/redact (webhooks.shop.redact.tsx) hard-deletes the merchant
-- row 48h after uninstall and relies on ON DELETE CASCADE to clean every
-- child row. Three child tables were created with the default ON DELETE
-- NO ACTION, which means the delete throws a FK violation for any
-- merchant who ever triggered enrichment, llms.txt, or scan-trigger
-- enqueueing — and Shopify does NOT retry GDPR redact webhooks on 5xx,
-- so the failure is silent.
--
-- This migration drops + recreates the three offending FKs with
-- ON DELETE CASCADE so shop/redact reliably propagates.
--
-- After this migration the full delete-merchant graph is:
--   merchants → appeal_letters      CASCADE (already)
--             → digest_emails       CASCADE (already)
--             → enrichment_webhook_log  CASCADE (this migration)
--             → llms_txt_requests       CASCADE (this migration)
--             → pending_scan_triggers   CASCADE (this migration)
--             → scans → violations  CASCADE (already)
--             → schema_enrichments  CASCADE (already)

ALTER TABLE enrichment_webhook_log
  DROP CONSTRAINT IF EXISTS enrichment_webhook_log_merchant_id_fkey,
  ADD CONSTRAINT enrichment_webhook_log_merchant_id_fkey
    FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE;

ALTER TABLE llms_txt_requests
  DROP CONSTRAINT IF EXISTS llms_txt_requests_merchant_id_fkey,
  ADD CONSTRAINT llms_txt_requests_merchant_id_fkey
    FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE;

ALTER TABLE pending_scan_triggers
  DROP CONSTRAINT IF EXISTS pending_scan_triggers_merchant_id_fkey,
  ADD CONSTRAINT pending_scan_triggers_merchant_id_fkey
    FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE;
