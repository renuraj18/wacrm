import { describe, it, expect, vi } from 'vitest'
import type { GraphqlRunner } from './client'
import {
  extractOrderNumber,
  formatOrderReply,
  lookupOrdersForPhone,
  OrderLookupAccessError,
  orderStage,
  toE164,
  type ShopifyOrderNode,
} from './orders'

// Shape of the live Shanthi Boutique order #1038.
const order1038: ShopifyOrderNode = {
  name: '#1038',
  createdAt: '2026-10-17T18:55:50Z',
  cancelledAt: null,
  displayFinancialStatus: 'PAID',
  displayFulfillmentStatus: 'FULFILLED',
  fulfillments: [
    {
      displayStatus: 'FULFILLED',
      trackingInfo: [
        {
          company: 'Professional Couriers',
          number: 'TCG922890',
          url: 'https://www.tpcindia.com/track-info.aspx?id=TCG922890&type=0&service=0',
        },
      ],
    },
    {
      displayStatus: 'FULFILLED',
      trackingInfo: [
        {
          company: 'Professional Couriers',
          number: 'TCG922890',
          url: 'https://www.tpcindia.com/track-info.aspx?id=TCG922890&type=0&service=0',
        },
      ],
    },
  ],
}

const order1041: ShopifyOrderNode = {
  name: '#1041',
  createdAt: '2026-11-01T06:00:00Z',
  cancelledAt: null,
  displayFinancialStatus: 'PENDING',
  displayFulfillmentStatus: 'UNFULFILLED',
  fulfillments: [],
}

function fakeGql(customer: { id: string; orders: ShopifyOrderNode[] } | null, older: ShopifyOrderNode[] = []) {
  const calls: { query: string; vars?: Record<string, unknown> }[] = []
  const gql = vi.fn(async (query: string, vars?: Record<string, unknown>) => {
    calls.push({ query, vars })
    if (query.includes('OrdersByPhone')) {
      return {
        shop: { ianaTimezone: 'Asia/Kolkata' },
        customers: {
          edges: customer
            ? [{ node: { id: customer.id, orders: { edges: customer.orders.map((node) => ({ node })) } } }]
            : [],
        },
      }
    }
    return { orders: { edges: older.map((node) => ({ node })) } }
  }) as unknown as GraphqlRunner
  return { gql, calls }
}

describe('toE164', () => {
  it('prefixes a WhatsApp id with +', () => {
    expect(toE164('919632982245')).toBe('+919632982245')
    expect(toE164('+91 96329-82245')).toBe('+919632982245')
  })
  it('rejects junk', () => {
    expect(toE164('')).toBeNull()
    expect(toE164('12345')).toBeNull()
  })
})

describe('extractOrderNumber', () => {
  it.each([
    ['#1038', '1038'],
    ['1038', '1038'],
    ['order status 1038 please', '1038'],
    ['# 1038', '1038'],
    ['9632982245', null],
    ['+91 96329 82245', null],
    ['order status', null],
    ['hi', null],
  ])('%s → %s', (text, expected) => {
    expect(extractOrderNumber(text)).toBe(expected)
  })
})

describe('orderStage', () => {
  it('maps fulfilment and cancellation states', () => {
    expect(orderStage(order1038)).toBe('shipped')
    expect(orderStage(order1041)).toBe('processing')
    expect(orderStage({ ...order1041, cancelledAt: '2026-11-02T00:00:00Z' })).toBe('cancelled')
    expect(orderStage({ ...order1041, displayFulfillmentStatus: 'PARTIALLY_FULFILLED' })).toBe('partly_shipped')
    expect(
      orderStage({ ...order1038, fulfillments: [{ displayStatus: 'DELIVERED', trackingInfo: [] }] }),
    ).toBe('delivered')
  })
})

describe('lookupOrdersForPhone', () => {
  const customer = { id: 'gid://shopify/Customer/31293157048399', orders: [order1041, order1038] }

  it('finds the customer by phone and returns recent orders', async () => {
    const { gql, calls } = fakeGql(customer)
    const result = await lookupOrdersForPhone(gql, '+917358282536', 'order status')
    expect(calls[0].vars).toEqual({ customerQuery: 'phone:+917358282536' })
    expect(result).toMatchObject({ kind: 'orders', requested: null, timeZone: 'Asia/Kolkata' })
    expect(result.kind === 'orders' && result.orders.map((o) => o.name)).toEqual(['#1041', '#1038'])
  })

  it('returns only the asked-for order when it belongs to the customer', async () => {
    const { gql } = fakeGql(customer)
    const result = await lookupOrdersForPhone(gql, '+917358282536', '#1038')
    expect(result.kind === 'orders' && result.orders.map((o) => o.name)).toEqual(['#1038'])
  })

  it('never reveals an order number from someone else', async () => {
    // Tester's number: a customer with no #1038 among their orders.
    const { gql, calls } = fakeGql({ id: 'gid://shopify/Customer/7753763881039', orders: [order1041] }, [])
    const result = await lookupOrdersForPhone(gql, '+919632982245', '1038')
    expect(result).toEqual({ kind: 'order_not_found', requested: '1038' })
    // The fallback search is scoped to this customer's id.
    expect(calls[1].vars).toEqual({ orderQuery: 'name:#1038 customer_id:7753763881039' })
  })

  it('finds an older order of the same customer outside the recent window', async () => {
    const { gql } = fakeGql({ id: 'gid://shopify/Customer/1', orders: [order1041] }, [order1038])
    const result = await lookupOrdersForPhone(gql, '+917358282536', '1038')
    expect(result.kind === 'orders' && result.orders[0].name).toBe('#1038')
  })

  it('reports no orders for an unknown phone', async () => {
    const { gql } = fakeGql(null)
    expect(await lookupOrdersForPhone(gql, '+910000000000', 'order status')).toEqual({ kind: 'no_orders' })
  })

  it('turns a missing-scope error into OrderLookupAccessError', async () => {
    const gql = vi.fn(async () => {
      throw new Error('Shopify API error: Access denied for customers field. Required access: `read_customers` access scope.')
    }) as unknown as GraphqlRunner
    await expect(lookupOrdersForPhone(gql, '+919632982245', '')).rejects.toBeInstanceOf(OrderLookupAccessError)
  })
})

describe('formatOrderReply', () => {
  it('formats a shipped order with courier and tracking (deduplicated)', () => {
    const text = formatOrderReply({ kind: 'orders', orders: [order1038], requested: '1038', timeZone: 'Asia/Kolkata' })
    expect(text).toContain('*#1038*')
    // 18:55 UTC on 17 Oct is 18 Oct in India.
    expect(text).toContain('18 Oct 2026')
    expect(text).toContain('Shipped')
    expect(text).toContain('Paid')
    expect(text.match(/Professional Couriers TCG922890/g)).toHaveLength(1)
    expect(text).toContain('https://www.tpcindia.com/track-info.aspx?id=TCG922890&type=0&service=0')
  })

  it('lists several orders and handles unpaid, unshipped ones', () => {
    const text = formatOrderReply({ kind: 'orders', orders: [order1041, order1038], requested: null, timeZone: 'UTC' })
    expect(text).toContain('*#1041*')
    expect(text).toContain('Being packed')
    expect(text).toContain('Payment pending')
  })

  it('explains not-found and no-orders politely', () => {
    expect(formatOrderReply({ kind: 'order_not_found', requested: '1038' })).toContain('#1038')
    expect(formatOrderReply({ kind: 'no_orders' })).toMatch(/couldn.t find any orders/i)
  })
})
