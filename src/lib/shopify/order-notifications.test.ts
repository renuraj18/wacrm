import { describe, expect, it } from 'vitest'

import {
  buildFulfillmentNotification,
  buildOrderNotification,
  cleanText,
  courierLabel,
  money,
  normalizeIndianPhone,
  summariseItems,
  trackingSlug,
  type OrderNotificationOrder,
} from './order-notifications'

const NOW = Date.parse('2026-11-10T10:00:00Z')
const MINUTES_AGO = (m: number) => new Date(NOW - m * 60_000).toISOString()

const base: OrderNotificationOrder = {
  id: 1001,
  name: '#1001',
  created_at: MINUTES_AGO(30),
  financial_status: 'paid',
  payment_gateway_names: ['razorpay'],
  total_price: '1499.00',
  line_items: [
    { name: 'Kolam Saree', quantity: 1 },
    { name: 'Kanchi Pattu', quantity: 2 },
  ],
  customer: { first_name: 'Priya', phone: '+919632982245' },
  shipping_address: { first_name: 'Priya', phone: '9632982245' },
}

describe('order placed', () => {
  it('orders/paid sends shanthi_order_placed with the items, total and payment', () => {
    expect(buildOrderNotification('orders/paid', base, NOW)).toEqual({
      dedupeKey: 'placed:1001',
      template: 'shanthi_order_placed',
      to: '919632982245',
      bodyParams: ['Priya', '#1001', 'Kolam Saree × 1, Kanchi Pattu × 2', '1,499', 'Paid online'],
    })
  })

  it('COD is announced on orders/create', () => {
    const cod = { ...base, financial_status: 'pending', payment_gateway_names: ['Cash on Delivery (COD)'] }
    expect(buildOrderNotification('orders/create', cod, NOW)?.bodyParams[4]).toBe('Cash on delivery')
  })

  it('an unpaid online order waits for orders/paid', () => {
    const unpaid = { ...base, financial_status: 'pending' }
    expect(buildOrderNotification('orders/create', unpaid, NOW)).toBeNull()
  })

  it('an order paid at checkout gets one message: orders/paid right after create is skipped', () => {
    const fresh = { ...base, created_at: MINUTES_AGO(1) }
    expect(buildOrderNotification('orders/create', fresh, NOW)?.dedupeKey).toBe('placed:1001')
    expect(buildOrderNotification('orders/paid', fresh, NOW)).toBeNull()
  })

  it('an online order paid later sends on orders/paid', () => {
    const later = { ...base, created_at: MINUTES_AGO(120), financial_status: 'pending' }
    expect(buildOrderNotification('orders/paid', later, NOW)?.template).toBe('shanthi_order_placed')
  })

  it('a normal order prefers the WhatsApp attribute, then the shipping phone', () => {
    const withAttr = { ...base, note_attributes: [{ name: 'WhatsApp', value: '+919000000001' }] }
    expect(buildOrderNotification('orders/paid', withAttr, NOW)?.to).toBe('919000000001')
  })

  it('no usable phone → nothing sent', () => {
    const none = { ...base, customer: null, shipping_address: null }
    expect(buildOrderNotification('orders/paid', none, NOW)).toBeNull()
  })
})

describe('reseller orders', () => {
  const reseller = {
    ...base,
    tags: ['Reseller', 'Courier: TPC'],
    billing_address: { first_name: 'Ravi Stores', phone: '9876543210' },
    shipping_address: { first_name: 'End Customer', phone: '9632982245' },
  }

  it('placed goes to the reseller (billing), named by the billing address', () => {
    const job = buildOrderNotification('orders/paid', reseller, NOW)
    expect(job?.to).toBe('919876543210')
    expect(job?.bodyParams[0]).toBe('Ravi Stores')
  })

  it('a tag string works too', () => {
    const job = buildOrderNotification('orders/paid', { ...reseller, tags: 'reseller, wholesale' }, NOW)
    expect(job?.to).toBe('919876543210')
  })
})

describe('cancelled', () => {
  it('uses the refunded amount when there is one, else the order total', () => {
    const refunded = {
      ...base,
      refunds: [{ transactions: [{ kind: 'refund', status: 'success', amount: '500.50' }] }],
    }
    expect(buildOrderNotification('orders/cancelled', refunded, NOW)).toMatchObject({
      dedupeKey: 'cancelled:1001',
      template: 'shanthi_order_cancelled',
      bodyParams: ['Priya', '#1001', '500.50'],
    })
    expect(buildOrderNotification('orders/cancelled', base, NOW)?.bodyParams[2]).toBe('1,499')
  })
})

describe('helpers', () => {
  it('normalises Indian numbers', () => {
    expect(normalizeIndianPhone('+91 96329 82245')).toBe('919632982245')
    expect(normalizeIndianPhone('09876543210')).toBe('919876543210')
    expect(normalizeIndianPhone('9876543210')).toBe('919876543210')
    expect(normalizeIndianPhone('123')).toBeNull()
    expect(normalizeIndianPhone(null)).toBeNull()
  })
  it('formats money like the relay', () => {
    expect(money('1499.00')).toBe('1,499')
    expect(money('1499.50')).toBe('1,499.50')
    expect(money('100000')).toBe('1,00,000')
  })
  it('cleans template values', () => {
    expect(cleanText('  a\n\nb\t c  ')).toBe('a b c')
  })
  it('truncates a long item list', () => {
    const items = Array.from({ length: 200 }, (_, i) => ({ name: `Saree design number ${i}`, quantity: 1 }))
    const text = summariseItems(items)
    expect(text.length).toBeLessThanOrEqual(700)
    expect(text).toMatch(/\+ \d+ more$/)
  })
})

describe('shipped (fulfillments)', () => {
  const parcel = {
    order_id: 1001,
    name: '#1001.1',
    status: 'success',
    tracking_number: 'DT123456',
    tracking_url: null,
    tracking_company: 'DTDC',
    destination: { first_name: 'Priya', phone: '9632982245' },
  }
  const noCtx = { reseller: null, orderCourier: null }

  it('names the courier and uses the v2 template, with the old one as fallback', () => {
    expect(buildFulfillmentNotification(parcel, noCtx)).toEqual({
      dedupeKey: 'shipped:1001:DT123456',
      template: 'shanthi_order_shipped_v2',
      to: '919632982245',
      bodyParams: ['Priya', '#1001', 'DTDC', 'DT123456'],
      buttonParam: 'DT123456',
      fallback: { template: 'shanthi_order_shipped', bodyParams: ['Priya', '#1001', 'DT123456'] },
      tracking: { number: 'DT123456', url: null, courier: 'DTDC' },
    })
  })

  it('waits until a tracking number exists, and skips cancelled fulfillments', () => {
    expect(buildFulfillmentNotification({ ...parcel, tracking_number: null }, noCtx)).toBeNull()
    expect(buildFulfillmentNotification({ ...parcel, status: 'cancelled' }, noCtx)).toBeNull()
  })

  it('uses the courier from the order tag when Shopify has none, else Professional Couriers', () => {
    const tagged = buildFulfillmentNotification(
      { ...parcel, tracking_company: null },
      { reseller: null, orderCourier: 'ST Courier' },
    )
    expect(tagged?.bodyParams[2]).toBe('ST Courier')
    expect(buildFulfillmentNotification({ ...parcel, tracking_company: null }, noCtx)?.bodyParams[2]).toBe(
      'Professional Couriers',
    )
  })

  it('sends a reseller order to the reseller, with the reseller name', () => {
    const job = buildFulfillmentNotification(parcel, {
      reseller: { phone: '919876543210', name: 'Ravi Stores' },
      orderCourier: null,
    })
    expect(job?.to).toBe('919876543210')
    expect(job?.bodyParams[0]).toBe('Ravi Stores')
  })

  it('keeps Shopify tracking URL and uses the first of tracking_urls', () => {
    const job = buildFulfillmentNotification(
      { ...parcel, tracking_url: null, tracking_urls: ['https://track.example/DT123456'] },
      noCtx,
    )
    expect(job?.tracking?.url).toBe('https://track.example/DT123456')
  })

  it('labels couriers and makes tracking slugs URL-safe', () => {
    expect(courierLabel('Professional Couriers')).toBe('Professional Couriers')
    expect(courierLabel('TPC')).toBe('Professional Couriers')
    expect(courierLabel('st courier')).toBe('ST Courier')
    expect(courierLabel('DTDC Express')).toBe('DTDC')
    expect(courierLabel('Other Co')).toBe('Other Co')
    expect(trackingSlug('DT 12/3.4')).toBe('DT1234')
  })
})
