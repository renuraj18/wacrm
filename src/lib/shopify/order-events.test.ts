import { describe, expect, it } from 'vitest'
import { ORDER_TOPIC_TRIGGERS, parseOrderEvent } from './order-events'

describe('parseOrderEvent', () => {
  it('prefers the order phone, then customer, shipping, billing', () => {
    const e = parseOrderEvent({
      phone: null,
      customer: { phone: '+91 63699 11749', first_name: 'Asha', last_name: 'K' },
      shipping_address: { phone: '+14155550123' },
    })
    expect(e.phone).toBe('916369911749')
    expect(e.name).toBe('Asha K')
    expect(e.vars.customer_first_name).toBe('Asha')
  })

  it('skips national-format numbers instead of guessing a country', () => {
    const e = parseOrderEvent({ phone: '6369911749', customer: { phone: '06369911749' } })
    expect(e.phone).toBeNull()
  })

  it('falls through to a later candidate when the first is unusable', () => {
    const e = parseOrderEvent({ phone: '12345', billing_address: { phone: '+919876543210' } })
    expect(e.phone).toBe('919876543210')
  })

  it('exposes order and tracking variables', () => {
    const e = parseOrderEvent({
      name: '#1042',
      total_price: '1499.00',
      currency: 'INR',
      order_status_url: 'https://shop.example/orders/abc',
      fulfillments: [{ tracking_company: 'DTDC', tracking_number: 'D123', tracking_url: 'https://t/D123' }],
    })
    expect(e.vars).toMatchObject({
      order_name: '#1042',
      order_total: '1499.00',
      order_currency: 'INR',
      tracking_company: 'DTDC',
      tracking_number: 'D123',
      tracking_url: 'https://t/D123',
    })
  })

  it('falls back to order_number when name is missing', () => {
    expect(parseOrderEvent({ order_number: 1042 }).vars.order_name).toBe('#1042')
  })
})

describe('ORDER_TOPIC_TRIGGERS', () => {
  it('maps each subscribed topic to a trigger', () => {
    expect(ORDER_TOPIC_TRIGGERS['orders/create']).toBe('shopify_order_created')
    expect(ORDER_TOPIC_TRIGGERS['orders/fulfilled']).toBe('shopify_order_fulfilled')
    expect(ORDER_TOPIC_TRIGGERS['orders/cancelled']).toBe('shopify_order_cancelled')
  })
})
