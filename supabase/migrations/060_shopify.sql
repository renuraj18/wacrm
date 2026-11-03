-- ============================================================
-- 060_shopify.sql — Shopify product catalogue
--
-- Pulls an account's active Shopify products into the CRM so agents
-- can send them from the inbox, attach them to deals, and so the AI
-- assistant can answer price / availability questions.
--
-- Connection model
--   A Shopify Dev Dashboard app installed on the merchant's store,
--   authenticated with the client-credentials grant. We store the app's
--   client id + secret (secret AES-256-GCM-encrypted, same `encrypt()`
--   as `whatsapp_config.access_token`) and cache the short-lived Admin
--   API token it mints (also encrypted). The client secret doubles as
--   the HMAC key Shopify signs product webhooks with.
--
-- Tables
--   shopify_config  one row per account (settings-class).
--   products        mirror of active Shopify products, upserted by the
--                   sync + webhook paths under the service-role client.
--   deal_products   products attached to a deal (quantity × unit price).
--
-- AI knowledge
--   Each product becomes one `ai_knowledge_documents` row with
--   source = 'shopify', so the existing chunk + retrieve path (030)
--   grounds AI replies in the catalogue with no new retrieval code.
--
-- RLS
--   shopify_config: admin+ only (it holds encrypted credentials).
--   products: any member reads; writes go through the service role.
--   deal_products: mirrors deals (member read, agent+ write).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ------------------------------------------------------------
-- shopify_config
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shopify_config (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id             uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  created_by             uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  shop_domain            text NOT NULL,          -- e.g. my-store.myshopify.com
  client_id              text NOT NULL,
  client_secret          text NOT NULL,          -- AES-256-GCM-encrypted
  access_token           text,                   -- AES-256-GCM-encrypted, short-lived
  token_expires_at       timestamptz,
  storefront_url         text,                   -- primary domain, for product links
  currency               text,
  ai_products_enabled    boolean NOT NULL DEFAULT true,
  webhooks_registered_at timestamptz,
  last_synced_at         timestamptz,
  last_sync_error        text,
  product_count          integer NOT NULL DEFAULT 0,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- Webhooks arrive with only the shop domain; this is how they find
-- their account.
CREATE UNIQUE INDEX IF NOT EXISTS shopify_config_shop_domain_idx
  ON shopify_config (lower(shop_domain));

ALTER TABLE shopify_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shopify_config_select ON shopify_config;
CREATE POLICY shopify_config_select ON shopify_config FOR SELECT
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS shopify_config_insert ON shopify_config;
CREATE POLICY shopify_config_insert ON shopify_config FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS shopify_config_update ON shopify_config;
CREATE POLICY shopify_config_update ON shopify_config FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS shopify_config_delete ON shopify_config;
CREATE POLICY shopify_config_delete ON shopify_config FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------
-- products
-- ------------------------------------------------------------

-- array_to_string is only STABLE, which a generated column rejects.
-- Joining text[] with a space is deterministic, so wrap it as IMMUTABLE.
CREATE OR REPLACE FUNCTION public.products_tags_text(tags text[])
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$ SELECT coalesce(array_to_string(tags, ' '), '') $$;

CREATE TABLE IF NOT EXISTS products (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  shopify_product_id  bigint NOT NULL,
  handle              text NOT NULL,
  title               text NOT NULL,
  description         text NOT NULL DEFAULT '',
  product_type        text NOT NULL DEFAULT '',
  vendor              text NOT NULL DEFAULT '',
  tags                text[] NOT NULL DEFAULT '{}',
  status              text NOT NULL DEFAULT 'active',
  image_url           text,
  price_min           numeric(12,2) NOT NULL DEFAULT 0,
  price_max           numeric(12,2) NOT NULL DEFAULT 0,
  currency            text NOT NULL DEFAULT 'INR',
  total_inventory     integer,
  tracks_inventory    boolean NOT NULL DEFAULT false,
  online_url          text,
  variants            jsonb NOT NULL DEFAULT '[]'::jsonb,
  shopify_updated_at  timestamptz,
  synced_at           timestamptz NOT NULL DEFAULT now(),
  fts                 tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(product_type, '') || ' ' || public.products_tags_text(tags)), 'B') ||
    setweight(to_tsvector('simple', coalesce(description, '')), 'C')
  ) STORED,
  UNIQUE (account_id, shopify_product_id)
);

CREATE INDEX IF NOT EXISTS products_account_title_idx ON products (account_id, title);
CREATE INDEX IF NOT EXISTS products_fts_idx ON products USING gin (fts);

ALTER TABLE products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS products_select ON products;
CREATE POLICY products_select ON products FOR SELECT
  USING (is_account_member(account_id));

-- ------------------------------------------------------------
-- deal_products
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deal_products (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  deal_id     uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity    integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price  numeric(12,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deal_id, product_id)
);

CREATE INDEX IF NOT EXISTS deal_products_deal_idx ON deal_products (deal_id);
CREATE INDEX IF NOT EXISTS deal_products_account_idx ON deal_products (account_id);

ALTER TABLE deal_products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deal_products_select ON deal_products;
CREATE POLICY deal_products_select ON deal_products FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS deal_products_insert ON deal_products;
CREATE POLICY deal_products_insert ON deal_products FOR INSERT
  WITH CHECK (
    is_account_member(account_id, 'agent')
    AND EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_id AND d.account_id = deal_products.account_id)
    AND EXISTS (SELECT 1 FROM products p WHERE p.id = product_id AND p.account_id = deal_products.account_id)
  );

DROP POLICY IF EXISTS deal_products_update ON deal_products;
CREATE POLICY deal_products_update ON deal_products FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS deal_products_delete ON deal_products;
CREATE POLICY deal_products_delete ON deal_products FOR DELETE
  USING (is_account_member(account_id, 'agent'));

-- ------------------------------------------------------------
-- AI knowledge: mark product-backed documents
-- ------------------------------------------------------------
ALTER TABLE ai_knowledge_documents
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES products(id) ON DELETE CASCADE;

-- Plain (not partial) unique index so `ON CONFLICT (product_id)` can
-- infer it for upserts; NULLs stay distinct, so manual documents
-- (product_id IS NULL) are unaffected.
DROP INDEX IF EXISTS ai_knowledge_documents_product_idx;
CREATE UNIQUE INDEX IF NOT EXISTS ai_knowledge_documents_product_uniq
  ON ai_knowledge_documents (product_id);

-- ------------------------------------------------------------
-- redeem_invitation: also treat the Shopify tables as account data
--
-- Redeeming an invite deletes the caller's old (solo, empty) account.
-- The emptiness check must cover every account-scoped table, or a
-- connected Shopify catalogue would be silently dropped. Body copied
-- from 047 with the three new tables added to the EXISTS list.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.redeem_invitation(
  p_token_hash TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_inv account_invitations%ROWTYPE;
  v_old_account_id UUID;
  v_old_account_owner UUID;
  v_has_other_members BOOLEAN;
  v_has_data BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed'
      USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;

  SELECT p.account_id, a.owner_user_id
  INTO v_old_account_id, v_old_account_owner
  FROM profiles p
  JOIN accounts a ON a.id = p.account_id
  WHERE p.user_id = v_caller_id
  FOR UPDATE OF p, a;

  IF v_old_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no profile' USING ERRCODE = '42501';
  END IF;

  IF v_old_account_id = v_inv.account_id THEN
    RAISE EXCEPTION 'You are already a member of this account'
      USING ERRCODE = '23505';
  END IF;

  IF v_old_account_owner <> v_caller_id THEN
    RAISE EXCEPTION 'You are already in a shared account; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE account_id = v_old_account_id
      AND user_id <> v_caller_id
  ) INTO v_has_other_members;

  IF v_has_other_members THEN
    RAISE EXCEPTION 'Your account has other members; remove them or transfer ownership before joining another account'
      USING ERRCODE = '23505';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM contacts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM conversations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM broadcasts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automation_logs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automation_pending_executions WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flows WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flow_runs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM pipelines WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM deals WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM message_templates WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM tags WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM custom_fields WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM contact_notes WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM whatsapp_config WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM api_keys WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM webhook_endpoints WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM quick_replies WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM notifications WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_configs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_knowledge_documents WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_knowledge_chunks WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_usage_log WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM shopify_config WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM products WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM deal_products WHERE account_id = v_old_account_id
    LIMIT 1
  ) INTO v_has_data;

  IF v_has_data THEN
    RAISE EXCEPTION 'Your account already contains data; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  UPDATE profiles
  SET account_id = v_inv.account_id,
      account_role = v_inv.role
  WHERE user_id = v_caller_id;

  UPDATE account_invitations
  SET accepted_at = NOW(),
      accepted_by_user_id = v_caller_id
  WHERE id = v_inv.id;

  DELETE FROM accounts WHERE id = v_old_account_id;

  RETURN v_inv.account_id;
END;
$$;

ALTER FUNCTION public.redeem_invitation(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.redeem_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(TEXT) TO authenticated;
