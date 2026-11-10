-- ============================================================
-- 067_shopify_tracking_links.sql — "Track my parcel" targets.
--
-- One row per parcel we sent a shipped message for. The public
-- /track/<slug> page reads it to send the customer to the right courier.
-- Public read happens through the service role in the route handler, so
-- RLS is on with no policies (no direct client access).
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS shopify_tracking_links (
  slug        text PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  number      text NOT NULL,
  url         text,
  courier     text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE shopify_tracking_links ENABLE ROW LEVEL SECURITY;
