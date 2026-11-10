import { describe, expect, it } from 'vitest'

import type { CartLine } from './cart'
import { collectionNamedIn, routeStore, type StoreDeps, type StoreReply } from './handler'
import { ids } from './ids'

const PHONE = '919632982245'

const variant = (id: string, qty: number, price = '850') => ({
  id: `gid://shopify/ProductVariant/${id}`,
  title: 'Red',
  price,
  compareAtPrice: null,
  availableForSale: qty > 0,
  inventoryQuantity: qty,
  inventoryPolicy: 'DENY',
  inventoryItem: { tracked: true },
})

const product = (id: string, title: string, qty: number) => ({
  id: `gid://shopify/Product/${id}`,
  title,
  onlineStoreUrl: 'https://shop.example/p',
  status: 'ACTIVE',
  totalInventory: qty,
  tracksInventory: true,
  priceRangeV2: { minVariantPrice: { amount: '850' } },
  options: [],
  featuredMedia: { preview: { image: { url: `https://img.example/${id}.jpg` } } },
  variants: { nodes: [variant(`${id}1`, qty)] },
})

/** Fake Shopify: answers each query by the fields it asks for. */
function fakeShopify(collections: { id: string; title: string; ticked: boolean }[], products: ReturnType<typeof product>[]) {
  return async (query: string, vars: Record<string, unknown> = {}) => {
    if (query.includes('published_status')) {
      return {
        collections: {
          nodes: collections.map((c) => ({
            id: c.id,
            title: c.title,
            handle: c.title.toLowerCase().replace(/\s+/g, '-'),
            productsCount: { count: 3 },
            metafield: { value: c.ticked ? 'true' : 'false' },
            image: { url: `https://img.example/${c.id}.jpg` },
          })),
        },
      }
    }
    if (query.includes('ProductVariant {')) {
      const ids = (vars.ids as string[]) ?? []
      return {
        nodes: ids.map((gid) => {
          const numeric = gid.split('/').pop()!
          const owner = products.find((p) => p.variants.nodes[0].id === gid)
          if (!owner) return null
          const v = owner.variants.nodes[0]
          return {
            ...v,
            id: gid,
            title: v.title,
            product: { title: owner.title, status: owner.status, onlineStoreUrl: owner.onlineStoreUrl },
            __numeric: numeric,
          }
        }),
      }
    }
    if (query.includes('collection(id')) {
      // Shopify rejects anything but a full collection id; fail the same way here.
      const id = String(vars.id ?? '')
      if (!/^gid:\/\/shopify\/Collection\/\d+$/.test(id)) throw new Error(`Invalid id: ${id}`)
      return { collection: { title: 'Kolam Sarees', products: { pageInfo: { hasNextPage: false }, edges: products.map((p, i) => ({ cursor: String(i), node: p })) } } }
    }
    if (query.includes('query: $q)')) {
      return { products: { pageInfo: { hasNextPage: false }, edges: products.map((p, i) => ({ cursor: String(i), node: p })) } }
    }
    if (query.includes('sortKey: CREATED_AT')) {
      return { products: { pageInfo: { hasNextPage: false }, edges: products.map((p, i) => ({ cursor: String(i), node: p })) } }
    }
    if (query.includes('collections(first: 1')) {
      return { collections: { nodes: [{ products: { pageInfo: { hasNextPage: false }, edges: products.map((p, i) => ({ cursor: String(i), node: p })) } }] } }
    }
    throw new Error(`unexpected query: ${query.slice(0, 60)}`)
  }
}

function deps(shopify: ReturnType<typeof fakeShopify>) {
  const carts = new Map<string, CartLine[]>()
  const d: StoreDeps = {
    run: shopify as unknown as StoreDeps['run'],
    shopUrl: 'https://shop.example',
    storeOrder: [],
    loadCart: async (phone) => carts.get(phone) ?? [],
    saveCart: async (phone, items) => {
      carts.set(phone, items)
    },
  }
  return { d, carts }
}

const shopify = fakeShopify(
  [{ id: 'gid://shopify/Collection/10', title: 'Kolam Sarees', ticked: true }, { id: 'gid://shopify/Collection/11', title: 'Kanchi Pattu', ticked: true }],
  [product('1', 'Kolam Saree', 5), product('2', 'Silk Saree', 0), product('3', 'Kolam Silk', 4)],
)

describe('routeStore', () => {
  it('leaves messages that are not about the store alone', async () => {
    const { d } = deps(shopify)
    expect(await routeStore(d, { phone: PHONE, text: 'where is my order' })).toBeNull()
  })

  it('"shop" opens the collections as photo cards', async () => {
    const { d } = deps(shopify)
    const [reply] = (await routeStore(d, { phone: PHONE, text: 'shop' })) as StoreReply[]
    expect(reply.kind).toBe('carousel')
    if (reply.kind !== 'carousel') return
    expect(reply.cards.map((c) => (c.buttons[0] as { url: string }).url)).toEqual([
      'https://shop.example/collections/kanchi-pattu',
      'https://shop.example/collections/kolam-sarees',
    ])
  })

  it('a collection name in a message opens that collection', async () => {
    const { d } = deps(shopify)
    const [reply] = (await routeStore(d, { phone: PHONE, text: 'kolam price?' })) as StoreReply[]
    expect(reply.kind).toBe('carousel')
    if (reply.kind !== 'carousel') return
    expect(reply.text).toContain('Kolam Sarees')
  })

  it('adding a saree puts it in the cart, and checkout gives the cart link', async () => {
    const { d, carts } = deps(shopify)
    const [added] = (await routeStore(d, { phone: PHONE, buttonId: ids.add('11') })) as StoreReply[]
    expect(added.kind).toBe('text')
    expect(carts.get(PHONE)).toEqual([
      { variantId: '11', productTitle: 'Kolam Saree', variantTitle: 'Red', price: 850, quantity: 1 },
    ])
    const [checkoutReply] = (await routeStore(d, { phone: PHONE, buttonId: ids.checkout })) as StoreReply[]
    if (checkoutReply.kind !== 'text') throw new Error('expected text')
    expect(checkoutReply.text).toContain('https://shop.example/cart/11:1?')
  })

  it('a sold-out saree cannot be added', async () => {
    const { d, carts } = deps(shopify)
    const [reply] = (await routeStore(d, { phone: PHONE, buttonId: ids.add('21') })) as StoreReply[]
    expect(reply.kind === 'text' && reply.text).toContain('sold out')
    expect(carts.get(PHONE)).toBeUndefined()
  })

  it('a catalogue cart fills the cart from the items sent', async () => {
    const { d, carts } = deps(shopify)
    await routeStore(d, { phone: PHONE, catalogItems: [{ retailer_id: 'shopify_IN_1_11', quantity: 2 }] })
    expect(carts.get(PHONE)?.[0].quantity).toBe(2)
  })
})

describe('new arrivals', () => {
  it('reads the newest products, not the best-seller list', async () => {
    const calls: string[] = []
    const spy = async (query: string, vars: Record<string, unknown> = {}) => {
      calls.push(query.includes('CREATED_AT') ? 'new' : 'other')
      return shopify(query, vars)
    }
    const { d } = deps(spy as unknown as ReturnType<typeof fakeShopify>)
    await routeStore(d, { phone: PHONE, buttonId: ids.newArrivals() })
    expect(calls).toContain('new')
    expect(calls).not.toContain('other')
  })
})

describe('collection names', () => {
  it('"kolam" shows the Kolam Sarees cards even when the collection is not ticked', async () => {
    const unticked = fakeShopify(
      [{ id: 'gid://shopify/Collection/10', title: 'Kolam Sarees', ticked: false }],
      [product('1', 'Kolam Saree', 5), product('3', 'Kolam Silk', 4)],
    )
    const { d } = deps(unticked)
    const [reply] = (await routeStore(d, { phone: PHONE, text: 'kolam' })) as StoreReply[]
    expect(reply.kind).toBe('carousel')
    const [again] = (await routeStore(d, { phone: PHONE, text: 'kolam sarees' })) as StoreReply[]
    expect(again.kind).toBe('carousel')
  })
})

describe('collection matching by name', () => {
  const both = fakeShopify(
    [
      { id: 'gid://shopify/Collection/20', title: 'Luxury Soft Silk', ticked: false },
      { id: 'gid://shopify/Collection/21', title: 'Soft Silk', ticked: false },
    ],
    [product('1', 'Soft Silk Saree', 5), product('3', 'Luxury Silk', 4)],
  )
  it('"luxury" matches Luxury Soft Silk by one of its words', async () => {
    const { d } = deps(both)
    const r = await collectionNamedIn(d, 'luxury')
    expect(r?.title).toBe('Luxury Soft Silk')
  })
  it('"soft silk" matches the Soft Silk collection, not Luxury Soft Silk', async () => {
    const { d } = deps(both)
    const r = await collectionNamedIn(d, 'soft silk')
    expect(r?.title).toBe('Soft Silk')
  })
})

describe('ambiguous collection words', () => {
  it('a word shared by two collections shows every saree with that word', async () => {
    const two = fakeShopify(
      [
        { id: 'gid://shopify/Collection/30', title: 'Silk Kanchi', ticked: false },
        { id: 'gid://shopify/Collection/31', title: 'Silk Banaras', ticked: false },
      ],
      [product('1', 'Silk Saree', 5), product('3', 'Silk Two', 4)],
    )
    const { d } = deps(two)
    const [reply] = (await routeStore(d, { phone: PHONE, text: 'silk' })) as StoreReply[]
    expect(reply.kind).toBe('carousel')
  })
})

describe('opening a collection by name', () => {
  it('"kolam" opens Kolam Sarees with a valid collection id (not a doubled Shopify prefix)', async () => {
    const one = fakeShopify(
      [{ id: 'gid://shopify/Collection/10', title: 'Kolam Sarees', ticked: false }],
      [product('1', 'Kolam Saree', 5), product('3', 'Kolam Silk', 4)],
    )
    const { d } = deps(one)
    const [reply] = (await routeStore(d, { phone: PHONE, text: 'kolam' })) as StoreReply[]
    expect(reply.kind).toBe('carousel')
  })
})

