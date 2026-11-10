-- ============================================================
-- 064_message_send_idempotency.sql
--
-- Give dashboard attachment sends a durable per-conversation request
-- key. The send route claims a `sending` message row before calling
-- Meta; a repeated key returns the saved result or a conflict while
-- delivery is still uncertain, rather than issuing a duplicate send.
--
-- Existing messages remain unchanged because the key is nullable.
-- ============================================================

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS client_request_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS messages_conversation_client_request_id_key
  ON public.messages (conversation_id, client_request_id)
  WHERE client_request_id IS NOT NULL;
