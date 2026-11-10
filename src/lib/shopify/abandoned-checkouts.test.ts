import { describe, expect, it } from 'vitest'

import { toRow, type AbandonedNode } from './abandoned-checkouts'

const checkout = (over: Partial<AbandonedNode> = {}): AbandonedNode => ({
  id: 'gid://shopify/AbandonedCheckout/1',
  name: 'Checkout #1',
  createdAt: '2026-11-09T10:00:00Z',
  updatedAt: '2026-11-09T10:05:00Z',
  completedAt: null,
  abandonedCheckoutUrl: 'https://shop.example/67871375439/invoices/recover?x=1',
  totalPriceSet: { shopMoney: { amount: '1499.00' } },
  customAttributes: [],
  customer: { firstName: 'Priya', defaultPhoneNumber: { phoneNumber: '+919632982245' } },
  shippingAddress: null,
  billingAddress: null,
  lineItems: { nodes: [{ title: 'Kolam Saree', variantTitle: 'Red', quantity: 1 }] },
  ...over,
})

describe('toRow', () => {
  it('uses the WhatsApp attribute first, then the customer phone', () => {
    const withAttr = checkout({ customAttributes: [{ key: 'WhatsApp', value: '+919000000001' }] })
    expect(toRow(withAttr, null).phone).toBe('919000000001')
    expect(toRow(checkout(), null).phone).toBe('919632982245')
  })

  it('falls back to the address phones when there is no customer', () => {
    const row = toRow(
      checkout({ customer: null, shippingAddress: { firstName: 'Ravi', phone: '9876543210' } }),
      null,
    )
    expect(row.phone).toBe('919876543210')
    expect(row.customerName).toBe('Ravi')
  })

  it('has no phone when nothing usable is on the checkout', () => {
    expect(toRow(checkout({ customer: null }), null).phone).toBeNull()
  })

  it('shows item and variant names with the total and the reminder time', () => {
    const row = toRow(checkout(), '2026-11-10T09:00:00Z')
    expect(row.items).toBe('Kolam Saree - Red × 1')
    expect(row.total).toBe('1,499')
    expect(row.remindedAt).toBe('2026-11-10T09:00:00Z')
  })
})
