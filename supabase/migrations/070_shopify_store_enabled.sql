-- ============================================================
-- 070_shopify_store_enabled.sql — per-account switch for the WhatsApp store.
--
-- Off by default. When on, customer messages that are store taps or store
-- words get store replies (cards, cart, checkout) instead of automations.
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE shopify_config
  ADD COLUMN IF NOT EXISTS store_enabled boolean NOT NULL DEFAULT false;
