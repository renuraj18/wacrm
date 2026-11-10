-- ============================================================
-- 072_message_retention.sql — per-account message retention (Settings).
--
-- message_retention holds how many months of messages stay in the inbox
-- (default 3). archive_account_messages moves one account's older messages
-- to messages_archive. archive_all_accounts runs that for every account and
-- is what the nightly job calls. Contacts are never touched.
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS message_retention (
  account_id          uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  months              integer NOT NULL DEFAULT 3 CHECK (months BETWEEN 1 AND 60),
  last_archived_at    timestamptz,
  last_archived_count integer NOT NULL DEFAULT 0
);

ALTER TABLE message_retention ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION archive_account_messages(p_account uuid, p_months integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  moved integer;
BEGIN
  WITH old AS (
    DELETE FROM messages m
    USING conversations c
    WHERE m.conversation_id = c.id
      AND c.account_id = p_account
      AND m.created_at < now() - make_interval(months => p_months)
    RETURNING m.*
  ), ins AS (
    INSERT INTO messages_archive SELECT * FROM old RETURNING 1
  )
  SELECT count(*) INTO moved FROM ins;

  INSERT INTO message_retention (account_id, months, last_archived_at, last_archived_count)
  VALUES (p_account, p_months, now(), moved)
  ON CONFLICT (account_id)
  DO UPDATE SET last_archived_at = now(), last_archived_count = moved;

  RETURN moved;
END;
$$;

CREATE OR REPLACE FUNCTION archive_all_accounts()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a record;
  total integer := 0;
BEGIN
  FOR a IN
    SELECT acc.id, COALESCE(mr.months, 3) AS months
    FROM accounts acc
    LEFT JOIN message_retention mr ON mr.account_id = acc.id
  LOOP
    total := total + archive_account_messages(a.id, a.months);
  END LOOP;
  RETURN total;
END;
$$;

-- Nightly (needs pg_cron): SELECT cron.schedule('archive-old-messages', '0 3 * * *', $$SELECT archive_all_accounts()$$);
