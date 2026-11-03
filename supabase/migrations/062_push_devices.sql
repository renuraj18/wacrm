-- ============================================================
-- 062_push_devices.sql — mobile push notification devices
--
-- The Expo mobile app registers each signed-in phone's Expo push token
-- here; the WhatsApp webhook sends a push to the right devices when a
-- customer message arrives.
--
-- One row per token (a token identifies one app install). Re-registering
-- the same token from a different user/account moves it, so a shared or
-- handed-over phone only notifies its current user.
--
-- RLS: a user sees and manages only their own devices. The webhook's
-- notifier reads under the service-role client.
--
-- Not account "data" for redeem_invitation's emptiness check: a phone
-- registered to a solo account must not block joining another account.
-- The row cascades away with the old account and the app re-registers.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS push_devices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expo_push_token  text NOT NULL UNIQUE,
  platform         text NOT NULL CHECK (platform IN ('ios', 'android')),
  app_version      text,
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS push_devices_account_user_idx
  ON push_devices (account_id, user_id);

ALTER TABLE push_devices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS push_devices_select ON push_devices;
CREATE POLICY push_devices_select ON push_devices FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS push_devices_insert ON push_devices;
CREATE POLICY push_devices_insert ON push_devices FOR INSERT
  WITH CHECK (user_id = auth.uid() AND is_account_member(account_id));

DROP POLICY IF EXISTS push_devices_update ON push_devices;
CREATE POLICY push_devices_update ON push_devices FOR UPDATE
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS push_devices_delete ON push_devices;
CREATE POLICY push_devices_delete ON push_devices FOR DELETE
  USING (user_id = auth.uid());

