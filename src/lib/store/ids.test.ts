import { describe, expect, it } from 'vitest'

import { ids, MAX_BUTTON_ID, parseStoreId } from './ids'

describe('store ids', () => {
  it('round-trip through parseStoreId', () => {
    expect(parseStoreId(ids.menu)).toEqual({ kind: 'menu' })
    expect(parseStoreId(ids.cart)).toEqual({ kind: 'cart' })
    expect(parseStoreId(ids.checkout)).toEqual({ kind: 'checkout' })
    expect(parseStoreId(ids.collection('123', 'Y3Vyc29y'))).toEqual({ kind: 'collection', collectionId: '123', after: 'Y3Vyc29y' })
    expect(parseStoreId(ids.collection('123'))).toEqual({ kind: 'collection', collectionId: '123', after: null })
    expect(parseStoreId(ids.product('55'))).toEqual({ kind: 'product', productId: '55' })
    expect(parseStoreId(ids.add('9'))).toEqual({ kind: 'add', variantId: '9' })
    expect(parseStoreId(ids.remove('9'))).toEqual({ kind: 'remove', variantId: '9' })
    expect(parseStoreId(ids.newArrivals())).toEqual({ kind: 'newArrivals', after: null })
    expect(parseStoreId(ids.bestSellers('abc'))).toEqual({ kind: 'bestSellers', after: 'abc' })
  })
  it('ignores ids that are not the store\'s, or are malformed', () => {
    expect(parseStoreId('order_status')).toBeNull()
    expect(parseStoreId('s:add:notanumber')).toBeNull()
    expect(parseStoreId('s:zzz')).toBeNull()
    expect(parseStoreId(null)).toBeNull()
  })
  it('stays under Meta\'s button id limit', () => {
    expect(ids.collection('1'.repeat(20), 'x'.repeat(100)).length).toBeLessThan(MAX_BUTTON_ID)
  })
})
