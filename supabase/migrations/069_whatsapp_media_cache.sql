-- ============================================================
-- 069_whatsapp_media_cache.sql — WhatsApp media ids for store photos.
--
-- WhatsApp downloads each photo once and returns a media id; sending by id
-- avoids downloading the photo again on every card. Rows expire after 30
-- days (WhatsApp media ids have a limited life).
-- Service-role only: RLS is on with no policies.
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS whatsapp_media_cache (
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  photo_url   text NOT NULL,
  media_id    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, photo_url)
);

ALTER TABLE whatsapp_media_cache ENABLE ROW LEVEL SECURITY;
