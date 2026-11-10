import { describe, expect, it } from 'vitest'

import { addToCart, cartText, cartTotal, reconcileCart, removeFromCart, type CartLine } from './cart'

const kolam = { variantId: 'v1', productTitle: 'Kolam Saree', variantTitle: 'Red', price: 850 }
const navy = { variantId: 'v2', productTitle: 'Silk Saree', variantTitle: '', price: 600 }

describe('addToCart', () => {
  it('adds a new line at quantity 1, then increments it', () => {
    let cart: CartLine[] = addToCart([], kolam, 5)
    expect(cart).toEqual([{ ...kolam, quantity: 1 }])
    cart = addToCart(cart, kolam, 5)
    expect(cart[0].quantity).toBe(2)
  })

  it('never goes above stock, and refuses a sold-out variant', () => {
    let cart: CartLine[] = addToCart([], kolam, 2)
    cart = addToCart(cart, kolam, 2)
    cart = addToCart(cart, kolam, 2)
    expect(cart[0].quantity).toBe(2)
    expect(addToCart([], kolam, 0)).toEqual([])
  })
})

describe('removeFromCart and totals', () => {
  it('removes one variant and totals the rest', () => {
    const cart: CartLine[] = [
      { ...kolam, quantity: 2 },
      { ...navy, quantity: 1 },
    ]
    expect(cartTotal(cart)).toBe(2300)
    expect(removeFromCart(cart, 'v1')).toEqual([{ ...navy, quantity: 1 }])
  })
})

describe('reconcileCart (checkout re-checks stock)', () => {
  it('drops sold-out lines and caps quantities at current stock', () => {
    const cart: CartLine[] = [
      { ...kolam, quantity: 3 },
      { ...navy, quantity: 1 },
    ]
    const result = reconcileCart(cart, new Map([['v1', 1], ['v2', 0]]))
    expect(result.items).toEqual([{ ...kolam, quantity: 1 }])
    expect(result.removed.map((l) => l.variantId)).toEqual(['v2'])
    expect(result.capped.map((l) => l.variantId)).toEqual(['v1'])
  })
})

describe('cartText', () => {
  it('lists lines with the total in rupees', () => {
    const cart: CartLine[] = [
      { ...kolam, quantity: 2 },
      { ...navy, quantity: 1 },
    ]
    expect(cartText(cart)).toBe('Kolam Saree - Red × 2\nSilk Saree × 1\nTotal: ₹2,300')
  })
  it('says when the cart is empty', () => {
    expect(cartText([])).toBe('Your cart is empty.')
  })
})
