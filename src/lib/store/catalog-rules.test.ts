import { describe, expect, it } from 'vitest'

import { inStock, MAX_QTY, priceLine, sellable, stockOf, variantName } from './catalog-rules'

const v = (over: Partial<{ availableForSale: boolean; inventoryQuantity: number | null; inventoryPolicy: string | null; inventoryItem: { tracked: boolean } | null; price: string; compareAtPrice: string | null }> = {}) => ({
  availableForSale: true,
  inventoryQuantity: 5,
  inventoryPolicy: 'DENY',
  inventoryItem: { tracked: true },
  price: '899',
  compareAtPrice: null,
  ...over,
})

describe('stockOf', () => {
  it('is 0 when not for sale, and caps at the most a customer may buy', () => {
    expect(stockOf(v({ availableForSale: false }))).toBe(0)
    expect(stockOf(v({ inventoryQuantity: 50 }))).toBe(MAX_QTY)
    expect(stockOf(v({ inventoryQuantity: 2 }))).toBe(2)
    expect(stockOf(v({ inventoryQuantity: -3 }))).toBe(0)
  })
  it('treats untracked stock and "continue selling" as available', () => {
    expect(stockOf(v({ inventoryQuantity: 0, inventoryItem: { tracked: false } }))).toBe(MAX_QTY)
    expect(stockOf(v({ inventoryQuantity: 0, inventoryPolicy: 'CONTINUE' }))).toBe(MAX_QTY)
  })
})

describe('sellable and inStock', () => {
  const product = { status: 'ACTIVE', onlineStoreUrl: 'https://shop.example/p' }
  it('needs an active product sold online', () => {
    expect(sellable(product)).toBe(true)
    expect(sellable({ ...product, status: 'DRAFT' })).toBe(false)
    expect(sellable({ ...product, onlineStoreUrl: null })).toBe(false)
  })
  it('hides a product whose stock Shopify counts but will not sell online', () => {
    expect(inStock({ ...product, tracksInventory: true, totalInventory: 0, variants: { nodes: [v()] } })).toBe(false)
    expect(inStock({ ...product, tracksInventory: true, totalInventory: 4, variants: { nodes: [v()] } })).toBe(true)
    expect(inStock({ ...product, variants: { nodes: [v({ availableForSale: false })] } })).toBe(false)
  })
})

describe('priceLine', () => {
  it('shows the cheapest buyable price, "From" when several variants, and the strike-through compare price', () => {
    const line = priceLine(
      [v({ price: '1200', compareAtPrice: '1500' }), v({ price: '899', compareAtPrice: '1200' })],
      '0',
    )
    expect(line).toBe('From ₹899 ~₹1200~')
  })
  it('warns when 3 or fewer are left', () => {
    expect(priceLine([v({ inventoryQuantity: 2 })], '0')).toBe('₹899 · 🔥 Only 2 left')
  })
  it('falls back to the product price when no variants are listed', () => {
    expect(priceLine([], '899')).toBe('₹899')
  })
})

describe('variantName', () => {
  it('joins product and variant, and drops "Default Title"', () => {
    expect(variantName('Kolam Saree', 'Red')).toBe('Kolam Saree – Red')
    expect(variantName('Kolam Saree', 'Default Title')).toBe('Kolam Saree')
    expect(variantName('  Kolam   Saree ', null)).toBe('Kolam Saree')
  })
})
