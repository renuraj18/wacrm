import { describe, expect, it } from 'vitest'

import { collectInStock, orderTicked, type StoreProduct } from './catalog-fetch'

const col = (handle: string, title: string, ticked: boolean) => ({
  id: `gid://shopify/Collection/${handle}`,
  title,
  handle,
  productsCount: { count: 3 },
  metafield: ticked ? { value: 'true' } : { value: 'false' },
  image: null,
})

describe('orderTicked', () => {
  it('keeps only ticked collections, in STORE_COLLECTIONS order, then A–Z', () => {
    const out = orderTicked(
      [col('zeta', 'Zeta', true), col('kolam', 'Kolam', true), col('plain', 'Plain', false), col('alpha', 'Alpha', true)],
      ['kolam'],
    )
    expect(out.map((c) => c.handle)).toEqual(['kolam', 'alpha', 'zeta'])
  })
})

const product = (id: string, sellable: boolean, stock: number): StoreProduct => ({
  id,
  title: id,
  image: null,
  status: sellable ? 'ACTIVE' : 'DRAFT',
  onlineStoreUrl: sellable ? 'https://shop.example/p' : null,
  tracksInventory: true,
  totalInventory: stock,
  priceRangeV2: { minVariantPrice: { amount: '899' } },
  options: [],
  variants: { nodes: [{ id: `${id}-v`, title: '', price: '899', compareAtPrice: null, availableForSale: stock > 0, inventoryQuantity: stock, inventoryPolicy: 'DENY', inventoryItem: { tracked: true } }] },
})

describe('collectInStock', () => {
  it('skips sold-out and unsold products, and reads further pages until it has enough', async () => {
    const pages: Record<string, { pageInfo: { hasNextPage: boolean }; edges: { cursor: string; node: unknown }[] }> = {
      start: {
        pageInfo: { hasNextPage: true },
        edges: [
          { cursor: 'c1', node: product('a', true, 0) },
          { cursor: 'c2', node: product('b', false, 5) },
          { cursor: 'c3', node: product('c', true, 2) },
        ],
      },
      c3: {
        pageInfo: { hasNextPage: false },
        edges: [{ cursor: 'c4', node: product('d', true, 1) }],
      },
    }
    const result = await collectInStock(async (cursor) => pages[cursor ?? 'start'] ?? null, null, 2)
    expect(result.products.map((p) => p.id)).toEqual(['c', 'd'])
    expect(result.next).toBeNull()
  })

  it('stops after the page limit and returns a cursor to continue from', async () => {
    const endless = async () => ({
      pageInfo: { hasNextPage: true },
      edges: [{ cursor: 'x', node: product('sold', true, 0) }],
    })
    const result = await collectInStock(endless, null, 10)
    expect(result.products).toEqual([])
    expect(result.next).toBe('x')
  })
})
