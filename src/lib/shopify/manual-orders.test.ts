import { describe, expect, it } from 'vitest'

import { buildDraftInput, invoicePath, ManualOrderError } from './manual-orders'

const variant = (n: number) => `gid://shopify/ProductVariant/${n}`
const base = {
  customerName: 'Priya',
  phone: '+91 96329 82245',
  items: [{ variantId: variant(42), quantity: 2 }],
}

describe('buildDraftInput', () => {
  it('builds the draft with the customer, tags and attributes the relay used', () => {
    const { input, name, phone } = buildDraftInput(base)
    expect(name).toBe('Priya')
    expect(phone).toBe('919632982245')
    expect(input).toMatchObject({
      taxExempt: true,
      phone: '+919632982245',
      tags: ['manual-order', 'whatsapp'],
      lineItems: [{ variantId: variant(42), quantity: 2 }],
      customAttributes: [
        { key: 'WhatsApp', value: '+919632982245' },
        { key: 'Customer name', value: 'Priya' },
      ],
    })
  })

  it('adds a price override for a variant and a custom item with its own price', () => {
    const { input } = buildDraftInput({
      ...base,
      items: [
        { variantId: variant(42), quantity: 1, price: '1,299' },
        { title: 'Blouse stitching', quantity: 1, price: '250' },
      ],
    })
    const [first, custom] = input.lineItems as Record<string, unknown>[]
    expect(first.priceOverride).toEqual({ amount: '1299.00', currencyCode: 'INR' })
    expect(custom).toMatchObject({
      title: 'Blouse stitching',
      originalUnitPriceWithCurrency: { amount: '250.00', currencyCode: 'INR' },
      taxable: false,
    })
  })

  it('adds shipping and a fixed discount only when they are above zero', () => {
    const plain = buildDraftInput(base).input
    expect(plain.shippingLine).toBeUndefined()
    expect(plain.appliedDiscount).toBeUndefined()

    const extras = buildDraftInput({ ...base, shipping: '50', discount: 100, note: 'Gift wrap' }).input
    expect(extras.shippingLine).toEqual({ title: 'Shipping', priceWithCurrency: { amount: '50.00', currencyCode: 'INR' } })
    expect(extras.appliedDiscount).toEqual({ title: 'Discount', value: 100, valueType: 'FIXED_AMOUNT' })
    expect(extras.note).toBe('Gift wrap')
  })

  it('rejects bad input with a readable message', () => {
    expect(() => buildDraftInput({ ...base, customerName: '  ' })).toThrow("Enter the customer's name")
    expect(() => buildDraftInput({ ...base, phone: '123' })).toThrow(ManualOrderError)
    expect(() => buildDraftInput({ ...base, items: [] })).toThrow('Add at least one item')
    expect(() => buildDraftInput({ ...base, items: [{ variantId: variant(1), quantity: 0 }] })).toThrow('quantity must be 1–100')
    expect(() => buildDraftInput({ ...base, items: [{ variantId: 'nope', quantity: 1 }] })).toThrow('invalid product')
    expect(() => buildDraftInput({ ...base, items: [{ title: 'x', quantity: 1, price: '-5' }] })).toThrow('valid amount')
  })
})

describe('invoicePath', () => {
  it('keeps the path and query, without the leading slash', () => {
    expect(invoicePath('https://shop.example/67871375439/invoices/abc123?key=xyz')).toBe(
      '67871375439/invoices/abc123?key=xyz',
    )
  })
})
