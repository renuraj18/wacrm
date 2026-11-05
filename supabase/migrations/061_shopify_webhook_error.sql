-- ============================================================
-- 061_shopify_webhook_error.sql — remember why live updates failed
--
-- Registering Shopify product webhooks can fail (no public https URL,
-- missing scope, Shopify userErrors) while the connection itself still
-- works. The reason used to be shown once in a toast and then lost;
-- keep it on the config row so Settings → Shopify can keep showing it
-- until a later registration succeeds.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE shopify_config
  ADD COLUMN IF NOT EXISTS webhook_error text;
