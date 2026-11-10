// ============================================================
// Button ids the store puts on its messages, and how they're read back.
// Every store id starts with "s:" so the router can tell them apart from
// the welcome buttons. Shopify ids are shortened to their numeric part.
// ============================================================

export const STORE_PREFIX = 's:'
export const MAX_BUTTON_ID = 256

export type StoreAction =
  | { kind: 'menu' }
  | { kind: 'collection'; collectionId: string; after: string | null }
  | { kind: 'newArrivals'; after: string | null }
  | { kind: 'bestSellers'; after: string | null }
  | { kind: 'product'; productId: string }
  | { kind: 'add'; variantId: string }
  | { kind: 'remove'; variantId: string }
  | { kind: 'cart' }
  | { kind: 'checkout' }

export const ids = {
  menu: 's:menu',
  cart: 's:cart',
  checkout: 's:checkout',
  newArrivals: (after?: string | null) => `s:n:${after ?? ''}`,
  bestSellers: (after?: string | null) => `s:b:${after ?? ''}`,
  collection: (collectionId: string, after: string | null = null) => `s:c:${collectionId}:${after ?? ''}`,
  product: (productId: string) => `s:p:${productId}`,
  add: (variantId: string) => `s:add:${variantId}`,
  remove: (variantId: string) => `s:rm:${variantId}`,
}

/** Reads a store button id. Returns null for ids that aren't the store's. */
export function parseStoreId(raw: string | null | undefined): StoreAction | null {
  const id = String(raw ?? '')
  if (!id.startsWith(STORE_PREFIX)) return null
  if (id === 's:menu') return { kind: 'menu' }
  if (id === 's:cart') return { kind: 'cart' }
  if (id === 's:checkout') return { kind: 'checkout' }
  const parts = id.split(':')
  const [, code, a = '', b = ''] = parts
  switch (code) {
    case 'n':
      return { kind: 'newArrivals', after: a || null }
    case 'b':
      return { kind: 'bestSellers', after: a || null }
    case 'c':
      // The cursor after the id is Shopify's (opaque text), so it's kept as-is.
      return /^\d+$/.test(a) ? { kind: 'collection', collectionId: a, after: b || null } : null
    case 'p':
      return /^\d+$/.test(a) ? { kind: 'product', productId: a } : null
    case 'add':
      return /^\d+$/.test(a) ? { kind: 'add', variantId: a } : null
    case 'rm':
      return /^\d+$/.test(a) ? { kind: 'remove', variantId: a } : null
    default:
      return null
  }
}
