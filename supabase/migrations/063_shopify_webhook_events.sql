-- ============================================================
-- 063_shopify_webhook_events.sql — dedupe Shopify order webhooks
--
-- Shopify delivers webhooks at-least-once and retries on timeouts, and
-- every order event can send a customer a WhatsApp message. The
-- X-Shopify-Webhook-Id header is stable across retries, so we claim it
-- here (INSERT … ON CONFLICT DO NOTHING) before dispatching: a repeat
-- delivery finds the row and is acknowledged without messaging anyone.
--
-- Service-role only: RLS is on with no policies.
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS shopify_webhook_events (
  webhook_id  text PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  topic       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shopify_webhook_events_created_idx
  ON shopify_webhook_events (created_at);

ALTER TABLE shopify_webhook_events ENABLE ROW LEVEL SECURITY;
