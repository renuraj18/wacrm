-- ============================================================
-- 071_message_archive.sql — keep messages in the inbox for 3 months.
--
-- Messages older than 3 months move to messages_archive. Contacts and
-- conversations are never touched: the archive has no foreign keys, so
-- archiving can't remove a contact. Photos and voice notes stay in storage.
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS messages_archive (LIKE messages INCLUDING ALL);

ALTER TABLE messages_archive ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION archive_old_messages(cutoff timestamptz DEFAULT now() - interval '3 months')
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  moved integer;
BEGIN
  WITH old AS (
    DELETE FROM messages WHERE created_at < cutoff RETURNING *
  ), inserted AS (
    INSERT INTO messages_archive SELECT * FROM old RETURNING 1
  )
  SELECT count(*) INTO moved FROM inserted;
  RETURN moved;
END;
$$;

-- Run every night at 03:00 (needs pg_cron, which Supabase offers):
-- SELECT cron.schedule('archive-old-messages', '0 3 * * *', $$SELECT archive_old_messages()$$);
