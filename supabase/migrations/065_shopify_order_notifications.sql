-- ============================================================
-- 065_shopify_order_notifications.sql — send the order messages that
-- the Shanthi relay used to send (placed, cancelled) from wacrm.
--
-- order_notifications_enabled is off by default: until an admin turns it
-- on, the relay keeps sending and wacrm sends nothing for these topics.
--
-- shopify_order_notification_sends is the send-once claim per message
-- (dedupe key = e.g. "placed:<order id>"), so Shopify retries and paired
-- events (orders/create + orders/paid) produce one message.
-- Service-role only: RLS is on with no policies.
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE shopify_config
  ADD COLUMN IF NOT EXISTS order_notifications_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS shopify_order_notification_sends (
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  dedupe_key  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, dedupe_key)
);

ALTER TABLE shopify_order_notification_sends ENABLE ROW LEVEL SECURITY;
