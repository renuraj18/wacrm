-- ============================================================
-- 068_shopify_store_carts.sql — WhatsApp store carts.
--
-- One cart per customer phone per account. Replaces the relay's Durable
-- Object cart. Carts unused for 30 days are ignored by the app.
-- Service-role only: RLS is on with no policies.
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS shopify_store_carts (
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  phone       text NOT NULL,
  items       jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, phone)
);

ALTER TABLE shopify_store_carts ENABLE ROW LEVEL SECURITY;
