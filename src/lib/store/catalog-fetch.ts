// ============================================================
// Store catalogue reads from Shopify (port of the relay's store queries).
// Stock and price come straight from Shopify on every read; nothing is
// synced into the database. Pure ordering/filtering is in catalog-rules.ts.
// ============================================================

import type { GraphqlRunner } from '@/lib/shopify/client'
import { inStock, type ProductSellability, type PricedVariant } from './catalog-rules'

/** Collections ticked "WhatsApp best selling" (a boolean metafield; collections can't have tags). */
export const BEST_FIELD = { namespace: 'custom', key: 'whatsapp_best_selling' } as const

/** Pages of products scanned per request, so sold-out best sellers don't leave a page short. */
export const MAX_PAGES = 4

const VARIANT_FIELDS = `id title price compareAtPrice availableForSale inventoryQuantity inventoryPolicy
  inventoryItem { tracked }`

const PRODUCT_FIELDS = `id title onlineStoreUrl status totalInventory tracksInventory
  priceRangeV2 { minVariantPrice { amount } } options { name }
  featuredMedia { preview { image { url(transform: {maxWidth: 600, preferredContentType: JPG}) } } }
  variants(first: 10) { nodes { ${VARIANT_FIELDS} } }`

const TICKED_COLLECTIONS = `query {
  collections(first: 100, query: "published_status:published", sortKey: TITLE) {
    nodes { id title handle productsCount { count }
      metafield(namespace: "${BEST_FIELD.namespace}", key: "${BEST_FIELD.key}") { value }
      image { url(transform: {maxWidth: 600, preferredContentType: JPG}) } } } }`

/** Every published collection, for matching a name in a message (ticking isn't needed for that). */
const ALL_COLLECTIONS = `query {
  collections(first: 250, query: "published_status:published", sortKey: TITLE) {
    nodes { id title handle } } }`

const COLLECTION_PRODUCTS = `query($id: ID!, $after: String) {
  collection(id: $id) { title
    products(first: 25, after: $after, sortKey: BEST_SELLING) {
      pageInfo { hasNextPage } edges { cursor node { ${PRODUCT_FIELDS} } } } } }`

const NEW_PRODUCTS = `query($after: String) {
  products(first: 25, after: $after, sortKey: CREATED_AT, reverse: true, query: "status:active") {
    pageInfo { hasNextPage } edges { cursor node { ${PRODUCT_FIELDS} } } } }`

const BEST_SELLERS = `query($q: String!, $after: String) {
  collections(first: 1, query: $q) { nodes { title
    products(first: 25, after: $after, sortKey: BEST_SELLING) {
      pageInfo { hasNextPage } edges { cursor node { ${PRODUCT_FIELDS} } } } } } }`

export interface TickedCollection {
  id: string
  title: string
  handle: string
  productsCount: number
  image: string | null
}

interface RawCollection {
  id: string
  title: string
  handle: string
  productsCount: { count: number } | null
  metafield: { value: string } | null
  image: { url: string } | null
}

/**
 * Collections ticked "WhatsApp best selling". Shown in STORE_COLLECTIONS
 * order (handles, comma-separated), then A–Z for the rest.
 */
export function orderTicked(collections: RawCollection[], storeOrder: string[]): TickedCollection[] {
  const ticked = collections
    .filter((c) => c.metafield?.value === 'true')
    .map((c) => ({
      id: c.id,
      title: c.title,
      handle: c.handle,
      productsCount: c.productsCount?.count ?? 0,
      image: c.image?.url ?? null,
    }))
  const rank = (handle: string) => {
    const i = storeOrder.indexOf(handle)
    return i === -1 ? Number.MAX_SAFE_INTEGER : i
  }
  return ticked.sort((a, b) => rank(a.handle) - rank(b.handle) || a.title.localeCompare(b.title))
}

export async function fetchAllCollections(run: GraphqlRunner): Promise<{ id: string; title: string; handle: string }[]> {
  const data = await run<{ collections: { nodes: { id: string; title: string; handle: string }[] } }>(ALL_COLLECTIONS)
  return data.collections.nodes
}

export async function fetchTickedCollections(
  run: GraphqlRunner,
  storeOrder: string[],
): Promise<TickedCollection[]> {
  const data = await run<{ collections: { nodes: RawCollection[] } }>(TICKED_COLLECTIONS)
  return orderTicked(data.collections.nodes, storeOrder)
}

export interface StoreProduct extends ProductSellability {
  id: string
  title: string
  /** Card photo URL (600 px), from the product's featured media. */
  image: string | null
  featuredMedia?: { preview: { image: { url: string } | null } | null } | null
  priceRangeV2: { minVariantPrice: { amount: string } }
  options: { name: string }[]
  variants: { nodes: (PricedVariant & { id: string; title: string })[] }
}

interface ProductConnection {
  pageInfo: { hasNextPage: boolean }
  edges: { cursor: string; node: unknown }[]
}

/** Keeps only products that can be bought now (sellable and in stock), in Shopify's order. */
export function pickInStock(nodes: StoreProduct[]): StoreProduct[] {
  return nodes.filter((p) => inStock(p))
}

/** Adds the photo URL the store cards use. */
export function withImage(p: StoreProduct): StoreProduct {
  return { ...p, image: p.image ?? p.featuredMedia?.preview?.image?.url ?? null }
}

/**
 * Pages through a product connection until `want` buyable products are found
 * or MAX_PAGES are scanned. Returns the products and the cursor for the next page.
 */
export async function collectInStock(
  fetchPage: (cursor: string | null) => Promise<ProductConnection | null>,
  start: string | null,
  want: number,
  maxPages = MAX_PAGES,
): Promise<{ products: StoreProduct[]; next: string | null }> {
  const products: StoreProduct[] = []
  let cursor = start
  for (let page = 0; page < maxPages; page++) {
    const conn = await fetchPage(cursor)
    if (!conn) break
    for (const e of conn.edges) {
      const p = withImage(e.node as StoreProduct)
      if (inStock(p)) products.push(p)
      cursor = e.cursor
      if (products.length >= want) break
    }
    if (products.length >= want || !conn.pageInfo.hasNextPage) {
      return { products, next: conn.pageInfo.hasNextPage ? cursor : null }
    }
  }
  return { products, next: cursor }
}

export async function fetchCollectionProducts(
  run: GraphqlRunner,
  collectionGid: string,
  after: string | null,
  want = 10,
): Promise<{ title: string | null; products: StoreProduct[]; next: string | null }> {
  let title: string | null = null
  const { products, next } = await collectInStock(async (cursor) => {
    const data = await run<{ collection: { title: string; products: ProductConnection } | null }>(
      COLLECTION_PRODUCTS,
      { id: collectionGid, after: cursor },
    )
    if (!data.collection) return null
    title = data.collection.title
    return data.collection.products
  }, after, want)
  return { title, products, next }
}

const TITLE_SEARCH = `query($q: String!, $after: String) {
  products(first: 25, after: $after, sortKey: RELEVANCE, query: $q) {
    pageInfo { hasNextPage } edges { cursor node { ${PRODUCT_FIELDS} } } } }`

/** Buyable sarees whose title has every one of these words (one Shopify query, not one per collection). */
export async function fetchByTitleWords(
  run: GraphqlRunner,
  words: string[],
  after: string | null,
  want = 10,
): Promise<{ products: StoreProduct[]; next: string | null }> {
  const safe = words.map((w) => w.replace(/[^a-z]/gi, '')).filter(Boolean)
  const q = `status:active AND ${safe.map((w) => `title:*${w}*`).join(' AND ')}`
  return collectInStock(async (cursor) => {
    const data = await run<{ products: ProductConnection }>(TITLE_SEARCH, { q, after: cursor })
    return data.products
  }, after, want, 2)
}

/** Newest active products first, keeping only ones that can be bought. Fewer pages than best sellers. */
export async function fetchNewArrivals(
  run: GraphqlRunner,
  after: string | null,
  want = 10,
): Promise<{ products: StoreProduct[]; next: string | null }> {
  return collectInStock(async (cursor) => {
    const data = await run<{ products: ProductConnection }>(NEW_PRODUCTS, { after: cursor })
    return data.products
  }, after, want, 2)
}

export async function fetchBestSellers(
  run: GraphqlRunner,
  handle: string,
  after: string | null,
  want = 10,
): Promise<{ products: StoreProduct[]; next: string | null }> {
  const safe = handle.replace(/[^\w-]/g, '')
  return collectInStock(async (cursor) => {
    const data = await run<{ collections: { nodes: { products: ProductConnection }[] } }>(BEST_SELLERS, {
      q: `handle:${safe}`,
      after: cursor,
    })
    return data.collections.nodes[0]?.products ?? null
  }, after, want)
}
