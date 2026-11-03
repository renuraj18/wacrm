import type { SupabaseClient } from '@supabase/supabase-js'
import type { GraphqlRunner } from './client'

// ============================================================
// Shopify product → `products` row mapping, full sync, and the
// single-product refresh the webhook uses.
// ============================================================

const PAGE_SIZE = 100
const VARIANTS_PER_PRODUCT = 50
const UPSERT_BATCH = 100

const PRODUCT_FIELDS = `
  id
  legacyResourceId
  handle
  title
  description
  productType
  vendor
  tags
  status
  updatedAt
  onlineStoreUrl
  tracksInventory
  totalInventory
  featuredMedia { preview { image { url } } }
  priceRangeV2 {
    minVariantPrice { amount currencyCode }
    maxVariantPrice { amount }
  }
  variants(first: ${VARIANTS_PER_PRODUCT}) {
    edges { node { id title sku price inventoryQuantity availableForSale } }
  }
`

export const SHOP_QUERY = `
  query ShopInfo {
    shop { name currencyCode myshopifyDomain primaryDomain { url } }
  }
`

const PRODUCTS_QUERY = `
  query ActiveProducts($first: Int!, $after: String) {
    products(first: $first, after: $after, query: "status:active") {
      edges { node { ${PRODUCT_FIELDS} } }
      pageInfo { hasNextPage endCursor }
    }
  }
`

const PRODUCT_QUERY = `
  query OneProduct($id: ID!) {
    product(id: $id) { ${PRODUCT_FIELDS} }
  }
`

export interface ShopInfo {
  name: string
  currencyCode: string
  myshopifyDomain: string
  primaryDomain: { url: string } | null
}

export interface ShopifyProductNode {
  id: string
  legacyResourceId: string
  handle: string
  title: string
  description: string | null
  productType: string | null
  vendor: string | null
  tags: string[] | null
  status: string
  updatedAt: string | null
  onlineStoreUrl: string | null
  tracksInventory: boolean | null
  totalInventory: number | null
  featuredMedia: { preview: { image: { url: string } | null } | null } | null
  priceRangeV2: {
    minVariantPrice: { amount: string; currencyCode: string }
    maxVariantPrice: { amount: string }
  } | null
  variants: {
    edges: {
      node: {
        id: string
        title: string
        sku: string | null
        price: string
        inventoryQuantity: number | null
        availableForSale: boolean
      }
    }[]
  } | null
}

export interface ProductVariant {
  id: string
  title: string
  sku: string | null
  price: number
  inventory: number | null
  available: boolean
}

export interface ProductRow {
  account_id: string
  shopify_product_id: number
  handle: string
  title: string
  description: string
  product_type: string
  vendor: string
  tags: string[]
  status: string
  image_url: string | null
  price_min: number
  price_max: number
  currency: string
  total_inventory: number | null
  tracks_inventory: boolean
  online_url: string | null
  variants: ProductVariant[]
  shopify_updated_at: string | null
  synced_at: string
}

/** Description cap — long marketing copy bloats the AI context. */
const MAX_DESCRIPTION = 2000

function toNumber(value: string | null | undefined): number {
  const n = Number.parseFloat(value ?? '')
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0
}

/**
 * Map one Admin API product to a `products` row. `storefrontUrl` is the
 * shop's primary domain, used when the product is not published to the
 * online store (onlineStoreUrl is null) so agents still get a link.
 */
export function mapProduct(
  node: ShopifyProductNode,
  accountId: string,
  storefrontUrl: string | null,
  now: Date = new Date(),
): ProductRow {
  const variants: ProductVariant[] = (node.variants?.edges ?? []).map(({ node: v }) => ({
    id: v.id,
    title: v.title,
    sku: v.sku,
    price: toNumber(v.price),
    inventory: v.inventoryQuantity,
    available: v.availableForSale,
  }))
  const base = storefrontUrl?.replace(/\/+$/, '') ?? null
  return {
    account_id: accountId,
    shopify_product_id: Number(node.legacyResourceId),
    handle: node.handle,
    title: node.title,
    description: (node.description ?? '').trim().slice(0, MAX_DESCRIPTION),
    product_type: node.productType ?? '',
    vendor: node.vendor ?? '',
    tags: node.tags ?? [],
    status: node.status.toLowerCase(),
    image_url: node.featuredMedia?.preview?.image?.url ?? null,
    price_min: toNumber(node.priceRangeV2?.minVariantPrice.amount),
    price_max: toNumber(node.priceRangeV2?.maxVariantPrice.amount),
    currency: node.priceRangeV2?.minVariantPrice.currencyCode ?? 'INR',
    total_inventory: node.totalInventory,
    tracks_inventory: !!node.tracksInventory,
    online_url: node.onlineStoreUrl ?? (base ? `${base}/products/${node.handle}` : null),
    variants,
    shopify_updated_at: node.updatedAt,
    synced_at: now.toISOString(),
  }
}

/** Stock state for display and AI text. Untracked products are always "in stock". */
export function stockLabel(
  p: Pick<ProductRow, 'tracks_inventory' | 'total_inventory'>,
): 'in_stock' | 'out_of_stock' {
  if (!p.tracks_inventory) return 'in_stock'
  return (p.total_inventory ?? 0) > 0 ? 'in_stock' : 'out_of_stock'
}

export async function fetchShopInfo(gql: GraphqlRunner): Promise<ShopInfo> {
  const data = await gql<{ shop: ShopInfo }>(SHOP_QUERY)
  return data.shop
}

export async function fetchAllActiveProducts(gql: GraphqlRunner): Promise<ShopifyProductNode[]> {
  const out: ShopifyProductNode[] = []
  let after: string | null = null
  for (;;) {
    const data: {
      products: {
        edges: { node: ShopifyProductNode }[]
        pageInfo: { hasNextPage: boolean; endCursor: string | null }
      }
    } = await gql(PRODUCTS_QUERY, { first: PAGE_SIZE, after })
    out.push(...data.products.edges.map((e) => e.node))
    if (!data.products.pageInfo.hasNextPage || !data.products.pageInfo.endCursor) break
    after = data.products.pageInfo.endCursor
  }
  return out
}

export async function fetchProduct(
  gql: GraphqlRunner,
  shopifyProductId: number | string,
): Promise<ShopifyProductNode | null> {
  const data = await gql<{ product: ShopifyProductNode | null }>(PRODUCT_QUERY, {
    id: `gid://shopify/Product/${shopifyProductId}`,
  })
  return data.product
}

/** Upsert rows and return their ids keyed by Shopify product id. */
export async function upsertProducts(
  db: SupabaseClient,
  rows: ProductRow[],
): Promise<Map<number, string>> {
  const ids = new Map<number, string>()
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const { data, error } = await db
      .from('products')
      .upsert(rows.slice(i, i + UPSERT_BATCH), { onConflict: 'account_id,shopify_product_id' })
      .select('id, shopify_product_id')
    if (error) throw error
    for (const r of data ?? []) ids.set(Number(r.shopify_product_id), r.id as string)
  }
  return ids
}

/** Delete local products whose Shopify id is not in `keep`. Returns the deleted count. */
export async function deleteMissingProducts(
  db: SupabaseClient,
  accountId: string,
  keep: Set<number>,
): Promise<number> {
  const { data, error } = await db
    .from('products')
    .select('id, shopify_product_id')
    .eq('account_id', accountId)
  if (error) throw error
  const stale = (data ?? [])
    .filter((r) => !keep.has(Number(r.shopify_product_id)))
    .map((r) => r.id as string)
  for (let i = 0; i < stale.length; i += UPSERT_BATCH) {
    const { error: delErr } = await db.from('products').delete().in('id', stale.slice(i, i + UPSERT_BATCH))
    if (delErr) throw delErr
  }
  return stale.length
}

export async function deleteProductByShopifyId(
  db: SupabaseClient,
  accountId: string,
  shopifyProductId: number,
): Promise<void> {
  const { error } = await db
    .from('products')
    .delete()
    .eq('account_id', accountId)
    .eq('shopify_product_id', shopifyProductId)
  if (error) throw error
}
