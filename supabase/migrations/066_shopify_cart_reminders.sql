-- ============================================================
-- 066_shopify_cart_reminders.sql — abandoned-checkout reminder log.
--
-- One row per abandoned checkout we've sent a WhatsApp reminder for, so
-- staff don't remind the same customer twice (unless they force it).
-- Rows expire after 90 days in the app; the table itself has no TTL.
--
-- Service-role only: RLS is on with no policies.
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS shopify_cart_reminders (
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  checkout_id  text NOT NULL,
  reminded_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, checkout_id)
);

ALTER TABLE shopify_cart_reminders ENABLE ROW LEVEL SECURITY;
