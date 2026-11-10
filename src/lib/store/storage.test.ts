import { describe, expect, it } from 'vitest'

import { isCartLine } from './storage'

describe('isCartLine', () => {
  it('accepts a complete cart line and rejects anything else', () => {
    expect(
      isCartLine({ variantId: '1', productTitle: 'Kolam', variantTitle: 'Red', price: 850, quantity: 2 }),
    ).toBe(true)
    expect(isCartLine({ variantId: '1', productTitle: 'Kolam', price: 850, quantity: 2 })).toBe(false)
    expect(isCartLine(null)).toBe(false)
    expect(isCartLine('x')).toBe(false)
  })
})
