import type { SupabaseClient } from '@supabase/supabase-js'
import { connectionGraphql, type ShopifyConnection } from './client'
import { clearProductKnowledge, syncProductKnowledge } from './knowledge'
import {
  deleteMissingProducts,
  deleteProductByShopifyId,
  fetchAllActiveProducts,
  fetchProduct,
  fetchShopInfo,
  mapProduct,
  upsertProducts,
} from './products'

// ============================================================
// Account-level orchestration: full catalogue sync and the
// single-product refresh driven by webhooks. Runs under the
// service-role client.
// ============================================================

export const CONFIG_COLUMNS =
  'id, account_id, shop_domain, client_id, client_secret, access_token, token_expires_at, storefront_url, currency, ai_products_enabled'

export interface StoredConnection extends ShopifyConnection {
  storefront_url: string | null
  currency: string | null
  ai_products_enabled: boolean
}

export async function loadConnection(
  db: SupabaseClient,
  accountId: string,
): Promise<StoredConnection | null> {
  const { data, error } = await db
    .from('shopify_config')
    .select(CONFIG_COLUMNS)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) throw error
  return (data as StoredConnection | null) ?? null
}

export async function loadConnectionByShop(
  db: SupabaseClient,
  shopDomain: string,
): Promise<StoredConnection | null> {
  const { data, error } = await db
    .from('shopify_config')
    .select(CONFIG_COLUMNS)
    .ilike('shop_domain', shopDomain)
    .maybeSingle()
  if (error) throw error
  return (data as StoredConnection | null) ?? null
}

export interface SyncResult {
  synced: number
  removed: number
}

/** Pull every active product, upsert, prune the rest, refresh knowledge. */
export async function syncAllProducts(
  db: SupabaseClient,
  conn: StoredConnection,
): Promise<SyncResult> {
  try {
    const gql = await connectionGraphql(db, conn)
    const shop = await fetchShopInfo(gql)
    const storefrontUrl = shop.primaryDomain?.url ?? null
    const nodes = await fetchAllActiveProducts(gql)
    const now = new Date()
    const rows = nodes.map((n) => mapProduct(n, conn.account_id, storefrontUrl, now))

    const ids = await upsertProducts(db, rows)
    const removed = await deleteMissingProducts(
      db,
      conn.account_id,
      new Set(rows.map((r) => r.shopify_product_id)),
    )

    if (conn.ai_products_enabled) {
      await syncProductKnowledge(
        db,
        conn.account_id,
        rows.flatMap((row) => {
          const productId = ids.get(row.shopify_product_id)
          return productId ? [{ productId, row }] : []
        }),
      )
    } else {
      await clearProductKnowledge(db, conn.account_id)
    }

    await db
      .from('shopify_config')
      .update({
        storefront_url: storefrontUrl,
        currency: shop.currencyCode,
        last_synced_at: now.toISOString(),
        last_sync_error: null,
        product_count: rows.length,
        updated_at: now.toISOString(),
      })
      .eq('id', conn.id)

    return { synced: rows.length, removed }
  } catch (err) {
    await db
      .from('shopify_config')
      .update({ last_sync_error: (err as Error).message ?? String(err) })
      .eq('id', conn.id)
    throw err
  }
}

/**
 * Re-read one product from Shopify and mirror it locally. A product
 * that no longer exists or is no longer active is removed (its
 * knowledge document cascades with it).
 */
export async function refreshProduct(
  db: SupabaseClient,
  conn: StoredConnection,
  shopifyProductId: number,
): Promise<'upserted' | 'removed'> {
  const gql = await connectionGraphql(db, conn)
  const node = await fetchProduct(gql, shopifyProductId)
  if (!node || node.status !== 'ACTIVE') {
    await deleteProductByShopifyId(db, conn.account_id, shopifyProductId)
    await bumpProductCount(db, conn)
    return 'removed'
  }
  const row = mapProduct(node, conn.account_id, conn.storefront_url)
  const ids = await upsertProducts(db, [row])
  const productId = ids.get(row.shopify_product_id)
  if (productId && conn.ai_products_enabled) {
    await syncProductKnowledge(db, conn.account_id, [{ productId, row }])
  }
  await bumpProductCount(db, conn)
  return 'upserted'
}

export async function removeProduct(
  db: SupabaseClient,
  conn: StoredConnection,
  shopifyProductId: number,
): Promise<void> {
  await deleteProductByShopifyId(db, conn.account_id, shopifyProductId)
  await bumpProductCount(db, conn)
}

async function bumpProductCount(db: SupabaseClient, conn: StoredConnection): Promise<void> {
  const { count } = await db
    .from('products')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', conn.account_id)
  await db
    .from('shopify_config')
    .update({ product_count: count ?? 0, updated_at: new Date().toISOString() })
    .eq('id', conn.id)
}
