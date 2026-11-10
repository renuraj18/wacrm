import { describe, expect, it } from 'vitest'

import { checkoutUrl, variantFromRetailerId } from './checkout'

describe('checkoutUrl', () => {
  it('fills the cart with variant:quantity pairs and tags the WhatsApp number', () => {
    const url = checkoutUrl('https://shanthiboutique.com/', [
      { variantId: '45678', quantity: 2 },
      { variantId: '8123', quantity: 1 },
    ], '919632982245')
    expect(url.startsWith('https://shanthiboutique.com/cart/45678:2,8123:1?')).toBe(true)
    const qs = new URL(url).searchParams
    expect(qs.get('attributes[WhatsApp]')).toBe('+919632982245')
    expect(qs.get('attributes[Ordered via]')).toBe('WhatsApp store')
    expect(qs.get('ref')).toBe('whatsapp-store')
  })
  it('uses the default shop when none is set', () => {
    expect(checkoutUrl(null, [{ variantId: '1', quantity: 1 }], '1')).toMatch(/^https:\/\/shanthiboutique\.com\/cart\/1:1\?/)
  })
})

describe('variantFromRetailerId', () => {
  it('reads the variant id from a catalog content id', () => {
    expect(variantFromRetailerId('shopify_IN_8123_45678')).toBe('45678')
    expect(variantFromRetailerId('45678')).toBe('45678')
    expect(variantFromRetailerId('')).toBeNull()
  })
})
